import type {
  DynamoDBDocumentClient,
  QueryCommandInput,
  TransactWriteCommandInput,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { Member, Project } from '../src/domain/entities.js';
import { DynamoClubRepository } from '../src/repositories/dynamo-club-repository.js';

const member: Member = {
  createdAt: '2026-01-01T00:00:00.000Z',
  displayName: 'Ada Lovelace',
  email: 'ada@ung.edu',
  handle: 'ada',
  id: '11111111-1111-4111-8111-111111111111',
  identityProvider: 'entra',
  identitySubject: 'entra-object-id',
  isPublicProfile: false,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
  newsletterOptIn: false,
  role: 'member',
  status: 'active',
  techStack: ['TypeScript'],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const project: Project = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'Description',
  id: '22222222-2222-4222-8222-222222222222',
  memberHandles: ['owner'],
  memberIds: ['33333333-3333-4333-8333-333333333333'],
  name: 'Club Website',
  ownerId: '33333333-3333-4333-8333-333333333333',
  status: 'published',
  techStack: ['TypeScript'],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('DynamoClubRepository access patterns', () => {
  it('prevents a deleted suspended identity from registering again', async () => {
    let retainedIdentity: Record<string, unknown> | undefined;
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({ Items: [] })
      .mockImplementationOnce((command: { input: TransactWriteCommandInput }) => {
        retainedIdentity = command.input.TransactItems?.[0]?.Put?.Item;
        const deletion = command.input.TransactItems?.[3]?.Delete;
        expect(deletion?.ConditionExpression).toContain('#status = :expectedStatus');
        expect(deletion?.ExpressionAttributeValues?.[':expectedStatus']).toBe('suspended');
        return Promise.resolve({});
      }).mockImplementationOnce(() => Promise.resolve({ Item: retainedIdentity }));
    const repository = new DynamoClubRepository('club-table', { send } as unknown as DynamoDBDocumentClient);
    await repository.deleteMemberPersonalData({ ...member, status: 'suspended' });
    await expect(repository.ensureMember({
      provider: member.identityProvider, subject: member.identitySubject,
      email: member.email, displayName: member.displayName, emailVerified: true,
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(retainedIdentity).toEqual({
      pk: `IDENTITY#${member.identityProvider}#${member.identitySubject}`,
      sk: 'LOOKUP', entityType: 'SuspendedIdentity', suspended: true,
    });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('reads RSVP from the caller partition key, including legacy records without eventId', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { pk: 'EVENT#event', sk: 'MEMBER#member', memberId: 'member', status: 'maybe' } });
    const repository = new DynamoClubRepository('club-table', { send } as unknown as DynamoDBDocumentClient);
    await expect(repository.getMemberEventRsvp('event', 'member')).resolves.toEqual({ memberId: 'member', status: 'maybe' });
    const command = send.mock.calls[0]?.[0] as { input: unknown };
    expect(command.input).toMatchObject({ ConsistentRead: true, Key: { pk: 'EVENT#event', sk: 'MEMBER#member' } });
  });

  it('creates a provider-neutral member UUID and private identity lookup atomically', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const member = await repository.ensureMember({
      displayName: 'Ada Lovelace',
      email: 'ada@ung.edu',
      emailVerified: true,
      provider: 'entra',
      subject: 'entra-object-id',
      tenantId: 'ung-tenant-id',
    });

    expect(member.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(member.id).not.toBe('entra-object-id');
    expect(member.handle).toMatch(/^member-[0-9a-f]{12}$/);
    expect(member.handle).not.toContain('ada');
    expect(member).toMatchObject({ isPublicProfile: false, newsletterOptIn: false });
    const command = send.mock.calls[1]?.[0] as { input: TransactWriteCommandInput };
    expect(command.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      id: member.id,
      pk: `USER#${member.id}`,
      sk: 'PROFILE',
    });
    expect(command.input.TransactItems?.[1]?.Put?.Item).toMatchObject({
      memberId: member.id,
      pk: 'IDENTITY#entra#entra-object-id',
      sk: 'LOOKUP',
    });
  });

  it('queries the public directory through a sparse opted-in member index', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          ...member,
          entityType: 'Member',
          gsi1pk: 'MEMBERS',
          gsi1sk: `HANDLE#${member.handle}#${member.id}`,
          gsi2pk: 'MEMBERS#PUBLIC',
          gsi2sk: `HANDLE#${member.handle}`,
          isPublicProfile: true,
          pk: `USER#${member.id}`,
          sk: 'PROFILE',
        },
      ],
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const page = await repository.listPublicDirectoryMembers(25);

    const command = send.mock.calls[0]?.[0] as { input: QueryCommandInput };
    expect(command.input).toMatchObject({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)',
    });
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':partition': 'MEMBERS#PUBLIC',
      ':public': true,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('gsi2pk');
  });

  it('normalizes legacy consent fields to private and unsubscribed', async () => {
    const { isPublicProfile: _public, newsletterOptIn: _newsletter, ...legacyMember } = member;
    const send = vi.fn().mockResolvedValue({
      Item: { ...legacyMember, pk: `USER#${member.id}`, sk: 'PROFILE' },
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.getMember(member.id)).resolves.toMatchObject({
      isPublicProfile: false,
      newsletterOptIn: false,
    });
  });

  it('reserves a user-chosen handle and updates directory indexes atomically', async () => {
    const updated = {
      ...member,
      handle: 'ada-codehawk',
      isPublicProfile: true,
      newsletterOptIn: true,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...updated, pk: `USER#${member.id}`, sk: 'PROFILE' } })
      .mockResolvedValueOnce({ Items: [] });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(
      repository.updateMemberProfile(member, {
        handle: updated.handle,
        isPublicProfile: true,
        newsletterOptIn: true,
      }),
    ).resolves.toMatchObject(updated);

    const command = send.mock.calls[0]?.[0] as { input: TransactWriteCommandInput };
    expect(command.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      memberId: member.id,
      pk: 'HANDLE#ada-codehawk',
      sk: 'LOOKUP',
    });
    expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':currentHandle': member.handle,
    });
    expect(command.input.TransactItems?.[2]?.Delete?.Key).toEqual({
      pk: `HANDLE#${member.handle}`,
      sk: 'LOOKUP',
    });
    expect(command.input.TransactItems?.[3]?.Put?.Item).toMatchObject({
      actorMemberId: member.id,
      changes: {
        isPublicProfile: { from: false, to: true },
        newsletterOptIn: { from: false, to: true },
      },
      entityType: 'MemberPreferenceAudit',
      memberId: member.id,
      pk: `USER#${member.id}`,
      policyVersion: '2026-08-23-v1',
      source: 'self_service_profile',
    });
  });

  it('changes an avatar only when the stored avatar still matches the caller snapshot', async () => {
    const current = {
      ...member,
      avatarUrl: `https://media.example.test/avatars/${member.id}/old.webp`,
    };
    const nextAvatarUrl = `https://media.example.test/avatars/${member.id}/new.webp`;
    const send = vi.fn().mockResolvedValueOnce({
      Attributes: {
        ...current,
        avatarUrl: nextAvatarUrl,
        pk: `USER#${member.id}`,
        sk: 'PROFILE',
      },
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.updateMemberAvatar(current, nextAvatarUrl)).resolves.toMatchObject({
      avatarUrl: nextAvatarUrl,
    });

    const command = send.mock.calls[0]?.[0] as { input: UpdateCommandInput };
    expect(command.input.ConditionExpression).toContain('#currentAvatar = :currentAvatar');
    expect(command.input.ExpressionAttributeNames?.['#currentAvatar']).toBe('avatarUrl');
    expect(command.input.ExpressionAttributeValues?.[':currentAvatar']).toBe(current.avatarUrl);
  });

  it('cascades a handle rename to indexed live memberships and resource projections', async () => {
    const renamed = { ...member, handle: 'new-handle' };
    const ownedProject = {
      ...project,
      memberHandles: [member.handle],
      memberIds: [member.id],
      ownerId: member.id,
    };
    const membership = {
      createdAt: member.createdAt,
      entityType: 'ProjectMembership',
      gsi2pk: `USER#${member.id}`,
      gsi2sk: `RESOURCE#PROJECT#${project.id}`,
      initiatedById: member.id,
      memberHandle: member.handle,
      memberId: member.id,
      pk: `PROJECT#${project.id}`,
      resourceId: project.id,
      resourceType: 'project',
      role: 'owner',
      sk: `MEMBER#${member.id}`,
      status: 'active',
      updatedAt: member.updatedAt,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...renamed, pk: `USER#${member.id}`, sk: 'PROFILE' } })
      .mockResolvedValueOnce({ Items: [membership] })
      .mockResolvedValueOnce({
        Item: { ...ownedProject, pk: `PROJECT#${project.id}`, sk: 'METADATA' },
      })
      .mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await repository.updateMemberProfile(member, { handle: renamed.handle });

    const cascade = send.mock.calls[4]?.[0] as { input: TransactWriteCommandInput };
    expect(cascade.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':memberHandle': renamed.handle,
      ':memberId': member.id,
    });
    expect(cascade.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':memberHandles': [renamed.handle],
    });
  });

  it('records the authenticated officer on role and status changes', async () => {
    const actor = { ...member, id: '99999999-9999-4999-8999-999999999999', role: 'president' as const };
    const updated = { ...member, role: 'treasurer' as const };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { ...member, pk: `USER#${member.id}`, sk: 'PROFILE' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...updated, pk: `USER#${member.id}`, sk: 'PROFILE' } });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await repository.administerMember(member.id, { role: 'treasurer' }, actor);

    const command = send.mock.calls[1]?.[0] as { input: TransactWriteCommandInput };
    const audit = command.input.TransactItems?.[1]?.Put?.Item;
    expect(audit).toMatchObject({
      actorId: actor.id,
      changes: { role: { from: 'member', to: 'treasurer' } },
      entityType: 'MemberAdministrationAudit',
      targetMemberId: member.id,
    });
  });

  it('exports indexed personal records without scanning the table', async () => {
    const notification = {
      actorDisplayName: 'Owner',
      actorHandle: 'owner',
      actorId: 'owner-id',
      createdAt: '2026-01-01T00:00:00.000Z',
      entityType: 'Notification',
      id: 'notification-id',
      message: 'Message',
      pk: `USER#${member.id}`,
      resourceId: project.id,
      resourceName: project.name,
      resourceType: 'project',
      sk: 'NOTIFICATION#notification-id',
      title: 'Title',
      type: 'resource_join_requested',
    };
    const membership = {
      createdAt: '2026-01-01T00:00:00.000Z',
      entityType: 'ProjectMembership',
      gsi2pk: `USER#${member.id}`,
      gsi2sk: `RESOURCE#PROJECT#${project.id}`,
      initiatedById: member.id,
      memberHandle: member.handle,
      memberId: member.id,
      pk: `PROJECT#${project.id}`,
      resourceId: project.id,
      resourceType: 'project',
      role: 'contributor',
      sk: `MEMBER#${member.id}`,
      status: 'active',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const preferenceAudit = {
      actorMemberId: member.id,
      changes: { newsletterOptIn: { from: false, to: true } },
      createdAt: '2026-01-02T00:00:00.000Z',
      entityType: 'MemberPreferenceAudit',
      id: 'preference-audit-id',
      memberId: member.id,
      pk: `USER#${member.id}`,
      policyVersion: '2026-08-23-v1',
      sk: 'PREFERENCE_AUDIT#2026-01-02T00:00:00.000Z#preference-audit-id',
      source: 'self_service_profile',
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { ...member, pk: `USER#${member.id}`, sk: 'PROFILE' } })
      .mockResolvedValueOnce({ Items: [notification, preferenceAudit] })
      .mockResolvedValueOnce({ Items: [membership] });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const result = await repository.exportMemberData(member.id);

    expect(result.profile).toEqual(member);
    expect(result.notifications).toHaveLength(1);
    expect(result.memberships).toHaveLength(1);
    expect(result.preferenceHistory).toEqual([
      expect.objectContaining({
        changes: { newsletterOptIn: { from: false, to: true } },
        policyVersion: '2026-08-23-v1',
      }),
    ]);
    for (const call of send.mock.calls.slice(1)) {
      const command = call[0] as { input: QueryCommandInput };
      expect(command.input).toHaveProperty('KeyConditionExpression');
    }
  });

  it('atomically removes identity lookups and leaves a nonpersonal deletion audit', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await repository.deleteMemberPersonalData(member);

    const command = send.mock.calls[2]?.[0] as { input: TransactWriteCommandInput };
    expect(command.input.TransactItems).toHaveLength(5);
    expect(command.input.TransactItems?.[0]?.Delete?.Key).toEqual({
      pk: `IDENTITY#${member.identityProvider}#${member.identitySubject}`,
      sk: 'LOOKUP',
    });
    const audit = command.input.TransactItems?.[4]?.Put?.Item;
    expect(audit).toMatchObject({ entityType: 'MemberDeletionAudit', pk: 'PRIVACY_AUDIT' });
    expect(audit).not.toHaveProperty('email');
    expect(audit).not.toHaveProperty('handle');
  });

  it('queries a member dashboard through the sparse membership GSI', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          entityType: 'ProjectMembership',
          gsi2pk: 'USER#member-id',
          gsi2sk: 'RESOURCE#PROJECT#project-id',
          initiatedById: 'member-id',
          memberHandle: 'ada',
          memberId: 'member-id',
          pk: 'PROJECT#project-id',
          resourceId: 'project-id',
          resourceType: 'project',
          role: 'owner',
          sk: 'MEMBER#member-id',
          status: 'active',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const page = await repository.listMemberResourceMemberships(
      'member-id',
      'project',
      'active',
      25,
    );

    const command = send.mock.calls[0]?.[0] as { input: QueryCommandInput };
    expect(command.input).toMatchObject({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)',
    });
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':partition': 'USER#member-id',
      ':prefix': 'RESOURCE#PROJECT#',
      ':status': 'active',
    });
    expect(page.items[0]).not.toHaveProperty('gsi2pk');
    expect(page.items[0]).toMatchObject({ resourceId: 'project-id', role: 'owner' });
  });

  it('creates an owner notification atomically with a project join request', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.requestProjectMembership(project, member)).resolves.toBe('requested');

    const command = send.mock.calls[1]?.[0] as { input: TransactWriteCommandInput };
    const notification = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.entityType === 'Notification',
    )?.Put?.Item;
    expect(notification).toMatchObject({
      actorHandle: member.handle,
      pk: `USER#${project.ownerId}`,
      resourceId: project.id,
      resourceType: 'project',
      type: 'resource_join_requested',
    });
    expect(String(notification?.sk)).toMatch(/^NOTIFICATION#[0-9]{13}-[0-9a-f-]{36}$/);
  });

  it('queries the member inbox newest-first and can filter unread notifications', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          actorDisplayName: member.displayName,
          actorHandle: member.handle,
          actorId: member.id,
          createdAt: '2026-01-01T00:00:00.000Z',
          entityType: 'Notification',
          id: '1767225600000-44444444-4444-4444-8444-444444444444',
          message: 'Ada Lovelace requested to join your project, Club Website.',
          pk: `USER#${project.ownerId}`,
          resourceId: project.id,
          resourceName: project.name,
          resourceType: 'project',
          sk: 'NOTIFICATION#1767225600000-44444444-4444-4444-8444-444444444444',
          title: 'New project join request',
          type: 'resource_join_requested',
        },
      ],
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const page = await repository.listMemberNotifications(project.ownerId, false, 25);

    const command = send.mock.calls[0]?.[0] as { input: QueryCommandInput };
    expect(command.input).toMatchObject({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)',
      ScanIndexForward: false,
    });
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':partition': `USER#${project.ownerId}`,
      ':prefix': 'NOTIFICATION#',
    });
    expect(page.items[0]).not.toHaveProperty('pk');
    expect(page.items[0]).toMatchObject({ type: 'resource_join_requested' });
  });

  it('creates a requester notification atomically when a join request is approved', async () => {
    const owner = {
      ...member,
      displayName: 'Project Owner',
      email: 'owner@ung.edu',
      handle: 'owner',
      id: project.ownerId,
      identitySubject: 'owner-entra-object-id',
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: { ...member, pk: `USER#${member.id}`, sk: 'PROFILE' },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: { ...project, pk: `PROJECT#${project.id}`, sk: 'METADATA' },
      });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await repository.reviewProjectMembership(project, owner, member.id, 'active');

    const command = send.mock.calls[1]?.[0] as { input: TransactWriteCommandInput };
    const notification = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.entityType === 'Notification',
    )?.Put?.Item;
    expect(notification).toMatchObject({
      actorHandle: owner.handle,
      pk: `USER#${member.id}`,
      resourceId: project.id,
      type: 'resource_join_approved',
    });
  });

  it('scopes notification read updates to the member partition', async () => {
    const notificationId = '1767225600000-44444444-4444-4444-8444-444444444444';
    const send = vi.fn().mockResolvedValue({
      Attributes: {
        id: notificationId,
        pk: `USER#${project.ownerId}`,
        readAt: '2026-01-02T00:00:00.000Z',
        sk: `NOTIFICATION#${notificationId}`,
      },
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await repository.updateNotificationReadState(project.ownerId, notificationId, true);

    const command = send.mock.calls[0]?.[0] as { input: UpdateCommandInput };
    expect(command.input).toMatchObject({
      Key: {
        pk: `USER#${project.ownerId}`,
        sk: `NOTIFICATION#${notificationId}`,
      },
      UpdateExpression: 'SET readAt = :readAt REMOVE gsi2pk, gsi2sk',
    });
  });

  it('queries only active newsletter opt-ins and rejects an unavailable delivery lease', async () => {
    const conditionalError = new Error('duplicate');
    conditionalError.name = 'ConditionalCheckFailedException';
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ ...member, newsletterOptIn: true }] })
      .mockRejectedValueOnce(conditionalError);
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const page = await repository.listNewsletterRecipients(100);
    await expect(repository.claimNewsletterDelivery('newsletter-id', member.id)).resolves.toBe(
      undefined,
    );

    const query = send.mock.calls[0]?.[0] as { input: QueryCommandInput };
    expect(query.input.FilterExpression).toBe(
      '#status = :active AND newsletterOptIn = :optedIn',
    );
    expect(query.input.ExpressionAttributeValues).toMatchObject({ ':optedIn': true });
    expect(page.items).toHaveLength(1);
    const claim = send.mock.calls[1]?.[0] as { input: UpdateCommandInput };
    expect(claim.input.ConditionExpression).toContain('leaseExpiresAt < :claimedAt');
    expect(claim.input.ConditionExpression).toContain('#outcome = :retryPending');
  });

  it('issues an owned five-minute delivery lease that can recover after expiry', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const claimToken = await repository.claimNewsletterDelivery('newsletter-id', member.id);

    expect(claimToken).toMatch(/^[0-9a-f-]{36}$/);
    const claim = send.mock.calls[0]?.[0] as { input: UpdateCommandInput };
    const values = claim.input.ExpressionAttributeValues ?? {};
    expect(Date.parse(String(values[':leaseExpiresAt'])) - Date.parse(String(values[':claimedAt']))).toBe(
      5 * 60 * 1000,
    );
    expect(values[':claimToken']).toBe(claimToken);
    expect(claim.input.UpdateExpression).toContain('#outcome = :claimed');
  });

  it('moves the leased claim across the provider ambiguity boundary by token', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(
      repository.beginNewsletterDeliveryAttempt('newsletter-id', member.id, 'claim-token'),
    ).resolves.toBe(true);

    const command = send.mock.calls[0]?.[0] as { input: UpdateCommandInput };
    expect(command.input.ConditionExpression).toContain('claimToken = :claimToken');
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':acceptedUnconfirmed': 'accepted_unconfirmed',
      ':claimToken': 'claim-token',
    });
    expect(command.input.UpdateExpression).toContain('REMOVE leaseExpiresAt');
  });

  it('paginates newsletter deliveries without exposing internal claim tokens', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          attemptStartedAt: '2026-01-01T00:01:00.000Z',
          claimToken: 'private-token',
          entityType: 'NewsletterDelivery',
          memberId: member.id,
          outcome: 'accepted_unconfirmed',
          pk: 'NEWSLETTER#newsletter-id',
          sk: `DELIVERY#${member.id}`,
        },
      ],
      LastEvaluatedKey: {
        pk: 'NEWSLETTER#newsletter-id',
        sk: `DELIVERY#${member.id}`,
      },
    });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    const page = await repository.listNewsletterDeliveries('newsletter-id', 10);

    expect(page.items[0]).toEqual({
      attemptStartedAt: '2026-01-01T00:01:00.000Z',
      memberId: member.id,
      outcome: 'accepted_unconfirmed',
    });
    expect(page.nextCursor).toBeTypeOf('string');
    const query = send.mock.calls[0]?.[0] as { input: QueryCommandInput };
    expect(query.input).toMatchObject({
      KeyConditionExpression: 'pk = :partition AND begins_with(sk, :prefix)',
      Limit: 10,
    });
  });

  it('reconciles legacy sending claims without automatically resending them', async () => {
    const newsletter = {
      body: 'Update',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: member.id,
      createdByHandle: member.handle,
      fanoutComplete: true,
      id: '44444444-4444-4444-8444-444444444444',
      processedCount: 1,
      recipientCount: 1,
      sentCount: 1,
      skippedCount: 0,
      status: 'sending',
      subject: 'News',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const actor = { ...member, role: 'president' as const };
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: { ...newsletter, pk: `NEWSLETTER#${newsletter.id}`, sk: 'METADATA' },
      });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(
      repository.reconcileNewsletterDelivery(
        newsletter.id,
        member.id,
        { reason: 'Confirmed in SES event telemetry.', resolution: 'mark_sent' },
        actor,
      ),
    ).resolves.toEqual(newsletter);

    const command = send.mock.calls[0]?.[0] as { input: TransactWriteCommandInput };
    const deliveryUpdate = command.input.TransactItems?.[0]?.Update;
    expect(deliveryUpdate?.ConditionExpression).toContain('#outcome = :legacySending');
    expect(deliveryUpdate?.ExpressionAttributeValues).toMatchObject({
      ':legacySending': 'sending',
      ':reconciledBy': actor.id,
      ':reason': 'Confirmed in SES event telemetry.',
    });
    expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':sentIncrement': 1,
    });
  });

  it('returns the original newsletter for a safe idempotent create retry', async () => {
    const conditionalError = new Error('duplicate');
    conditionalError.name = 'ConditionalCheckFailedException';
    const input = {
      body: 'Weekly update',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      subject: 'News',
    };
    const existing = {
      body: input.body,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: member.id,
      createdByHandle: member.handle,
      fanoutComplete: false,
      id: input.idempotencyKey,
      processedCount: 0,
      recipientCount: 0,
      sentCount: 0,
      skippedCount: 0,
      status: 'queued',
      subject: input.subject,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({
        Item: { ...existing, pk: `NEWSLETTER#${existing.id}`, sk: 'METADATA' },
      });
    const repository = new DynamoClubRepository(
      'club-table',
      { send } as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.createNewsletter(member, input)).resolves.toEqual(existing);
  });
});

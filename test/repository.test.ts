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
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
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
});

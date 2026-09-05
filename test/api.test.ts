import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api.js';
import type { AppConfig } from '../src/config.js';
import type { Member, Newsletter, Project, Team } from '../src/domain/entities.js';
import type { NewsletterQueue } from '../src/email/newsletter-queue.js';
import { conflict } from '../src/lib/errors.js';
import type { MediaService } from '../src/media/s3-media-service.js';
import type { ClubRepository } from '../src/repositories/club-repository.js';

const config: AppConfig = {
  allowedEmailDomain: 'ung.edu',
  authProvider: 'entra',
  entraApiClientId: 'client-id',
  entraTenantId: 'tenant-id',
  logLevel: 'info',
  mediaBucketName: 'media',
  mediaPublicBaseUrl: 'https://media.example.test',
  newsletterQueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/newsletters',
  tableName: 'table',
};

function event(path: string, method = 'GET'): APIGatewayProxyEventV2 {
  return {
    headers: {},
    isBase64Encoded: false,
    rawPath: path,
    rawQueryString: '',
    requestContext: {
      accountId: 'account',
      apiId: 'api',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'request-id',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    routeKey: `${method} ${path}`,
    version: '2.0',
  };
}

function authenticatedEvent(
  path: string,
  method: string,
  body?: Record<string, unknown>,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const base = event(path, method);
  return {
    ...base,
    ...(body ? { body: JSON.stringify(body) } : {}),
    requestContext: {
      ...base.requestContext,
      authorizer: {
        integrationLatency: 0,
        jwt: {
          claims: {
            aud: 'client-id',
            oid: 'entra-object-id',
            preferred_username: 'owner@ung.edu',
            tid: 'tenant-id',
          },
          scopes: ['access_as_user'],
        },
        principalId: 'entra-object-id',
      },
    },
  };
}

const owner: Member = {
  createdAt: '2026-01-01T00:00:00.000Z',
  displayName: 'Owner',
  email: 'owner@ung.edu',
  handle: 'owner',
  id: '11111111-1111-4111-8111-111111111111',
  identityProvider: 'entra',
  identitySubject: 'entra-object-id',
  identityTenant: 'tenant-id',
  isPublicProfile: false,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
  newsletterOptIn: false,
  role: 'member',
  status: 'active',
  techStack: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const deliveryNewsletter: Newsletter = {
  body: 'Hello club!',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: owner.id,
  createdByHandle: owner.handle,
  fanoutComplete: true,
  id: '44444444-4444-4444-8444-444444444444',
  processedCount: 0,
  recipientCount: 1,
  sentCount: 0,
  skippedCount: 0,
  status: 'sending',
  subject: 'Weekly update',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const project: Project = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'Description',
  id: '22222222-2222-4222-8222-222222222222',
  memberHandles: ['owner'],
  memberIds: [owner.id],
  name: 'Project',
  ownerId: owner.id,
  status: 'published',
  techStack: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const team: Team = {
  category: 'project',
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'Description',
  id: '44444444-4444-4444-8444-444444444444',
  joinPolicy: 'approval_required',
  maxMembers: 8,
  memberCount: 1,
  memberHandles: ['owner'],
  memberIds: [owner.id],
  name: 'Team',
  ownerId: owner.id,
  status: 'open',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('API', () => {
  it('loads only the authenticated member RSVP and returns null when absent', async () => {
    const getMemberEventRsvp = vi.fn().mockResolvedValueOnce({ status: 'going', memberId: owner.id }).mockResolvedValueOnce(undefined);
    const repository = { ensureMember: vi.fn().mockResolvedValue(owner), getMemberEventRsvp } as unknown as ClubRepository;
    const api = createApi({ config, repository });
    const path = '/v1/events/22222222-2222-4222-8222-222222222222/rsvp';
    const response = await api({ ...authenticatedEvent(path, 'GET'), queryStringParameters: { memberId: 'someone-else' } });
    expect(response.statusCode).toBe(200);
    expect(getMemberEventRsvp).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', owner.id);
    expect(JSON.parse((await api(authenticatedEvent(path, 'GET'))).body as string)).toEqual({ data: null });
    expect((await api(event(path))).statusCode).toBe(401);
    expect(getMemberEventRsvp).toHaveBeenCalledTimes(2);
  });

  it('handles CORS preflight without touching DynamoDB or authentication', async () => {
    const ensureMember = vi.fn();
    const repository = { ensureMember } as unknown as ClubRepository;
    const response = await createApi({ config, repository })(event('/v1/me', 'OPTIONS'));

    expect(response.statusCode).toBe(204);
    expect(ensureMember).not.toHaveBeenCalled();
    expect(response.body).toBeUndefined();
  });

  it('serves health without touching DynamoDB or authentication', async () => {
    const ensureMember = vi.fn();
    const repository = { ensureMember } as unknown as ClubRepository;
    const response = await createApi({ config, repository })(event('/health'));

    expect(response.statusCode).toBe(200);
    expect(ensureMember).not.toHaveBeenCalled();
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ data: { status: 'ok' } });
  });

  it('lists only the projects returned by the public repository query', async () => {
    const listProjects = vi.fn().mockResolvedValue({
      items: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          description: 'Description',
          id: 'project-id',
          imageUrl: 'https://tracker.example.test/pixel.png',
          memberHandles: ['ada'],
          memberIds: ['private-entra-object-id'],
          name: 'Project',
          ownerId: 'private-entra-object-id',
          status: 'published',
          techStack: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: 'next',
    });
    const repository = { listProjects } as unknown as ClubRepository;
    const response = await createApi({ config, repository })(event('/v1/projects'));

    expect(response.statusCode).toBe(200);
    expect(listProjects).toHaveBeenCalledWith(25, undefined);
    const body = JSON.parse(response.body ?? '{}') as {
      data: Array<Record<string, unknown>>;
      meta: { nextCursor: string };
    };
    expect(body.meta).toEqual({ nextCursor: 'next' });
    expect(body.data[0]).toMatchObject({ id: 'project-id' });
    expect(body.data[0]).not.toHaveProperty('memberHandles');
    expect(body.data[0]).not.toHaveProperty('imageUrl');
    expect(body.data[0]).not.toHaveProperty('memberIds');
    expect(body.data[0]).not.toHaveProperty('ownerId');
  });

  it('rejects malformed pagination limits before querying DynamoDB', async () => {
    const listTeams = vi.fn();
    const repository = { listTeams } as unknown as ClubRepository;
    const invalidEvent = { ...event('/v1/teams'), queryStringParameters: { limit: '1000' } };
    const response = await createApi({ config, repository })(invalidEvent);

    expect(response.statusCode).toBe(400);
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('lets a project owner invite a known active member', async () => {
    const target = {
      ...owner,
      email: 'target@ung.edu',
      handle: 'target',
      id: '33333333-3333-4333-8333-333333333333',
      identitySubject: 'target-entra-object-id',
    };
    const inviteResourceMember = vi.fn().mockResolvedValue(undefined);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      getMember: vi.fn().mockResolvedValue(target),
      getProject: vi.fn().mockResolvedValue(project),
      inviteResourceMember,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent(`/v1/projects/${project.id}/invitations`, 'POST', {
        memberId: target.id,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(inviteResourceMember).toHaveBeenCalledWith('project', project, owner, target);
  });

  it('lets a project owner directly add a known active member', async () => {
    const target = {
      ...owner,
      email: 'target@ung.edu',
      handle: 'target',
      id: '33333333-3333-4333-8333-333333333333',
      identitySubject: 'target-entra-object-id',
    };
    const updatedProject = {
      ...project,
      memberHandles: [...project.memberHandles, target.handle],
      memberIds: [...project.memberIds, target.id],
    };
    const addResourceMember = vi.fn().mockResolvedValue(updatedProject);
    const repository = {
      addResourceMember,
      ensureMember: vi.fn().mockResolvedValue(owner),
      getMember: vi.fn().mockResolvedValue(target),
      getProject: vi.fn().mockResolvedValue(project),
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent(`/v1/projects/${project.id}/members`, 'POST', {
        memberId: target.id,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(addResourceMember).toHaveBeenCalledWith('project', project, owner, target);
  });

  it('creates a constrained avatar upload for the signed-in member', async () => {
    const createAvatarUpload = vi.fn().mockResolvedValue({
      fields: { key: `pending/avatars/${owner.id}/avatar.webp` },
      uploadId: '12345678-1234-4123-8123-123456789abc.webp',
      uploadUrl: 'https://media-bucket.s3.amazonaws.com',
    });
    const mediaService = { createAvatarUpload } as unknown as MediaService;
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
    } as unknown as ClubRepository;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent('/v1/me/avatar-upload', 'POST', {
        contentType: 'image/webp',
        fileSize: 1024,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(createAvatarUpload).toHaveBeenCalledWith(owner, {
      contentType: 'image/webp',
      fileSize: 1024,
    });
  });

  it('creates a constrained project image upload for the project owner', async () => {
    const createResourceImageUpload = vi.fn().mockResolvedValue({
      fields: { key: `pending/projects/${project.id}/image.webp` },
      uploadId: '12345678-1234-4123-8123-123456789abc.webp',
      uploadUrl: 'https://media-bucket.s3.amazonaws.com',
    });
    const mediaService = { createResourceImageUpload } as unknown as MediaService;
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      getProject: vi.fn().mockResolvedValue(project),
    } as unknown as ClubRepository;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent(`/v1/projects/${project.id}/image-upload`, 'POST', {
        contentType: 'image/webp',
        fileSize: 2048,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(createResourceImageUpload).toHaveBeenCalledWith('project', project.id, {
      contentType: 'image/webp',
      fileSize: 2048,
    });
  });

  it('server-finalizes and attaches a project image for its owner', async () => {
    const uploadId = '12345678-1234-4123-8123-123456789abc.webp';
    const publicUrl = `https://media.example.test/projects/${project.id}/${uploadId}`;
    const finalizeResourceImageUpload = vi.fn().mockResolvedValue({ publicUrl });
    const updateProject = vi.fn().mockResolvedValue({ ...project, imageUrl: publicUrl });
    const mediaService = { finalizeResourceImageUpload } as unknown as MediaService;
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      getProject: vi.fn().mockResolvedValue(project),
      updateProject,
    } as unknown as ClubRepository;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent(`/v1/projects/${project.id}/image-upload/finalize`, 'POST', {
        uploadId,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(finalizeResourceImageUpload).toHaveBeenCalledWith('project', project.id, uploadId);
    expect(updateProject).toHaveBeenCalledWith(project, { imageUrl: publicUrl });
  });

  it('creates a constrained team image upload for the team owner', async () => {
    const createResourceImageUpload = vi.fn().mockResolvedValue({
      fields: { key: `pending/teams/${team.id}/image.png` },
      uploadId: '12345678-1234-4123-8123-123456789abc.png',
      uploadUrl: 'https://media-bucket.s3.amazonaws.com',
    });
    const mediaService = { createResourceImageUpload } as unknown as MediaService;
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      getTeam: vi.fn().mockResolvedValue(team),
    } as unknown as ClubRepository;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent(`/v1/teams/${team.id}/image-upload`, 'POST', {
        contentType: 'image/png',
        fileSize: 4096,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(createResourceImageUpload).toHaveBeenCalledWith('team', team.id, {
      contentType: 'image/png',
      fileSize: 4096,
    });
  });

  it('creates an event image upload only for an event-managing officer', async () => {
    const officer = { ...owner, role: 'reservation_designee' as const };
    const clubEvent = {
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: officer.id,
      description: 'Meeting',
      endsAt: '2026-09-01T23:00:00.000Z',
      id: '66666666-6666-4666-8666-666666666666',
      location: 'Room 101',
      name: 'Club meeting',
      published: true,
      startsAt: '2026-09-01T22:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const createResourceImageUpload = vi.fn().mockResolvedValue({
      fields: { key: `pending/events/${clubEvent.id}/image.webp` },
      uploadId: '12345678-1234-4123-8123-123456789abc.webp',
      uploadUrl: 'https://media-bucket.s3.amazonaws.com',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(officer),
      getEvent: vi.fn().mockResolvedValue(clubEvent),
    } as unknown as ClubRepository;
    const mediaService = { createResourceImageUpload } as unknown as MediaService;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent(`/v1/events/${clubEvent.id}/image-upload`, 'POST', {
        contentType: 'image/webp',
        fileSize: 1024,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(createResourceImageUpload).toHaveBeenCalledWith('event', clubEvent.id, {
      contentType: 'image/webp',
      fileSize: 1024,
    });
  });

  it('does not issue a project image upload to an unrelated member', async () => {
    const unrelatedMember: Member = {
      ...owner,
      email: 'other@ung.edu',
      handle: 'other',
      id: '55555555-5555-4555-8555-555555555555',
      identitySubject: 'other-entra-object-id',
    };
    const createResourceImageUpload = vi.fn();
    const mediaService = { createResourceImageUpload } as unknown as MediaService;
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(unrelatedMember),
      getProject: vi.fn().mockResolvedValue(project),
    } as unknown as ClubRepository;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent(`/v1/projects/${project.id}/image-upload`, 'POST', {
        contentType: 'image/png',
        fileSize: 1024,
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(createResourceImageUpload).not.toHaveBeenCalled();
  });

  it('updates an optional member tech stack without a separate onboarding flow', async () => {
    const updated = { ...owner, techStack: ['TypeScript', 'AWS'] };
    const updateMemberProfile = vi.fn().mockResolvedValue(updated);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateMemberProfile,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent('/v1/me', 'PATCH', {
        techStack: ['TypeScript', 'typescript', 'AWS'],
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(updateMemberProfile).toHaveBeenCalledWith(owner, {
      techStack: ['TypeScript', 'AWS'],
    });
  });

  it('lists unread inbox notifications for the signed-in member', async () => {
    const listMemberNotifications = vi.fn().mockResolvedValue({
      items: [
        {
          actorDisplayName: 'Ada',
          actorHandle: 'ada',
          actorId: '33333333-3333-4333-8333-333333333333',
          createdAt: '2026-01-01T00:00:00.000Z',
          id: '1767225600000-44444444-4444-4444-8444-444444444444',
          message: 'Ada requested to join your project, Project.',
          resourceId: project.id,
          resourceName: project.name,
          resourceType: 'project',
          title: 'New project join request',
          type: 'resource_join_requested',
        },
      ],
      nextCursor: 'next',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      listMemberNotifications,
    } as unknown as ClubRepository;
    const request = authenticatedEvent('/v1/me/notifications', 'GET');
    request.queryStringParameters = { limit: '10', read: 'false' };

    const response = await createApi({ config, repository })(request);

    expect(response.statusCode).toBe(200);
    expect(listMemberNotifications).toHaveBeenCalledWith(owner.id, false, 10, undefined);
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({
      data: [{ type: 'resource_join_requested' }],
      meta: { nextCursor: 'next' },
    });
  });

  it('marks only a notification in the signed-in member inbox as read', async () => {
    const notificationId = '1767225600000-44444444-4444-4444-8444-444444444444';
    const updateNotificationReadState = vi.fn().mockResolvedValue({
      id: notificationId,
      readAt: '2026-01-02T00:00:00.000Z',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateNotificationReadState,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent(`/v1/me/notifications/${notificationId}`, 'PATCH', { read: true }),
    );

    expect(response.statusCode).toBe(200);
    expect(updateNotificationReadState).toHaveBeenCalledWith(owner.id, notificationId, true);
  });

  it('lists the signed-in member resource relationships for dashboard discovery', async () => {
    const listMemberResourceMemberships = vi.fn().mockResolvedValue({
      items: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          initiatedById: owner.id,
          memberHandle: owner.handle,
          memberId: owner.id,
          resourceId: project.id,
          resourceType: 'project',
          role: 'owner',
          status: 'active',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: 'next',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      listMemberResourceMemberships,
    } as unknown as ClubRepository;
    const request = authenticatedEvent('/v1/me/memberships', 'GET');
    request.queryStringParameters = { resourceType: 'project', status: 'active' };

    const response = await createApi({ config, repository })(request);

    expect(response.statusCode).toBe(200);
    expect(listMemberResourceMemberships).toHaveBeenCalledWith(
      owner.id,
      'project',
      'active',
      25,
      undefined,
    );
  });

  it('queues a newsletter when the signed-in user is an officer', async () => {
    const officer = { ...owner, role: 'vice_president' as const };
    const newsletter = {
      body: 'Hello club!',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: officer.id,
      createdByHandle: officer.handle,
      fanoutComplete: false,
      id: '44444444-4444-4444-8444-444444444444',
      processedCount: 0,
      recipientCount: 0,
      sentCount: 0,
      skippedCount: 0,
      status: 'queued' as const,
      subject: 'Weekly update',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const startNewsletter = vi.fn().mockResolvedValue(undefined);
    const newsletterQueue = { startNewsletter } as unknown as NewsletterQueue;
    const repository = {
      createNewsletter: vi.fn().mockResolvedValue(newsletter),
      ensureMember: vi.fn().mockResolvedValue(officer),
    } as unknown as ClubRepository;

    const response = await createApi({ config, newsletterQueue, repository })(
      authenticatedEvent('/v1/newsletters', 'POST', {
        body: newsletter.body,
        idempotencyKey: newsletter.id,
        subject: newsletter.subject,
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(startNewsletter).toHaveBeenCalledWith(newsletter.id);
  });

  it('forbids ordinary members from sending newsletters', async () => {
    const startNewsletter = vi.fn();
    const createNewsletter = vi.fn();
    const repository = {
      createNewsletter,
      ensureMember: vi.fn().mockResolvedValue(owner),
    } as unknown as ClubRepository;

    const response = await createApi({
      config,
      newsletterQueue: { startNewsletter } as unknown as NewsletterQueue,
      repository,
    })(
      authenticatedEvent('/v1/newsletters', 'POST', {
        body: 'Hello club!',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        subject: 'Weekly update',
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(createNewsletter).not.toHaveBeenCalled();
    expect(startNewsletter).not.toHaveBeenCalled();
  });

  it('paginates delivery reconciliation records only for authorized senior officers', async () => {
    const officer = { ...owner, role: 'vice_president' as const };
    const listNewsletterDeliveries = vi.fn().mockResolvedValue({
      items: [
        {
          attemptStartedAt: '2026-01-01T00:01:00.000Z',
          memberId: owner.id,
          outcome: 'accepted_unconfirmed',
        },
      ],
      nextCursor: 'next',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(officer),
      getNewsletter: vi.fn().mockResolvedValue(deliveryNewsletter),
      listNewsletterDeliveries,
    } as unknown as ClubRepository;
    const request = authenticatedEvent(
      `/v1/newsletters/${deliveryNewsletter.id}/deliveries`,
      'GET',
    );
    request.queryStringParameters = { cursor: 'cursor', limit: '10' };

    const response = await createApi({ config, repository })(request);

    expect(response.statusCode).toBe(200);
    expect(listNewsletterDeliveries).toHaveBeenCalledWith(
      deliveryNewsletter.id,
      10,
      'cursor',
    );
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ meta: { nextCursor: 'next' } });
  });

  it('requires explicit duplicate-risk acknowledgement and requeues a reconciled delivery', async () => {
    const officer = { ...owner, role: 'president' as const };
    const enqueueDeliveries = vi.fn().mockResolvedValue(undefined);
    const reconcileNewsletterDelivery = vi.fn().mockResolvedValue(deliveryNewsletter);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(officer),
      getNewsletter: vi.fn().mockResolvedValue(deliveryNewsletter),
      reconcileNewsletterDelivery,
    } as unknown as ClubRepository;
    const reconciliation = {
      acknowledgePossibleDuplicate: true,
      reason: 'SES telemetry confirms no accepted message.',
      resolution: 'retry' as const,
    };

    const response = await createApi({
      config,
      newsletterQueue: { enqueueDeliveries } as unknown as NewsletterQueue,
      repository,
    })(
      authenticatedEvent(
        `/v1/newsletters/${deliveryNewsletter.id}/deliveries/${owner.id}/reconcile`,
        'POST',
        reconciliation,
      ),
    );

    expect(response.statusCode).toBe(202);
    expect(reconcileNewsletterDelivery).toHaveBeenCalledWith(
      deliveryNewsletter.id,
      owner.id,
      reconciliation,
      officer,
    );
    expect(enqueueDeliveries).toHaveBeenCalledWith(deliveryNewsletter.id, [owner.id]);
  });

  it('can repeat a durable retry-pending reconciliation after queue failure', async () => {
    const officer = { ...owner, role: 'president' as const };
    const enqueueDeliveries = vi
      .fn()
      .mockRejectedValueOnce(new Error('SQS unavailable'))
      .mockResolvedValueOnce(undefined);
    const reconcileNewsletterDelivery = vi.fn().mockResolvedValue(deliveryNewsletter);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(officer),
      getNewsletter: vi.fn().mockResolvedValue(deliveryNewsletter),
      reconcileNewsletterDelivery,
    } as unknown as ClubRepository;
    const request = () =>
      authenticatedEvent(
        `/v1/newsletters/${deliveryNewsletter.id}/deliveries/${owner.id}/reconcile`,
        'POST',
        {
          acknowledgePossibleDuplicate: true,
          reason: 'SES telemetry confirms no accepted message.',
          resolution: 'retry',
        },
      );
    const api = createApi({
      config,
      newsletterQueue: { enqueueDeliveries } as unknown as NewsletterQueue,
      repository,
    });

    await expect(api(request())).resolves.toMatchObject({ statusCode: 500 });
    await expect(api(request())).resolves.toMatchObject({ statusCode: 202 });
    expect(reconcileNewsletterDelivery).toHaveBeenCalledTimes(2);
    expect(enqueueDeliveries).toHaveBeenCalledTimes(2);
  });

  it('finishes newsletter status after the last manual delivery reconciliation', async () => {
    const officer = { ...owner, role: 'vice_president' as const };
    const reconciled = {
      ...deliveryNewsletter,
      processedCount: 1,
      sentCount: 1,
    };
    const updateNewsletterStatus = vi.fn().mockResolvedValue({
      ...reconciled,
      status: 'sent',
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(officer),
      getNewsletter: vi.fn().mockResolvedValue(deliveryNewsletter),
      reconcileNewsletterDelivery: vi.fn().mockResolvedValue(reconciled),
      updateNewsletterStatus,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent(
        `/v1/newsletters/${deliveryNewsletter.id}/deliveries/${owner.id}/reconcile`,
        'POST',
        {
          reason: 'Confirmed as accepted in SES event telemetry.',
          resolution: 'mark_sent',
        },
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(updateNewsletterStatus).toHaveBeenCalledWith(
      deliveryNewsletter.id,
      'sending',
      'sent',
    );
    expect(JSON.parse(response.body ?? '{}')).toMatchObject({ data: { status: 'sent' } });
  });

  it('forbids a treasurer from reconciling ambiguous deliveries', async () => {
    const treasurer = { ...owner, role: 'treasurer' as const };
    const listNewsletterDeliveries = vi.fn();
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(treasurer),
      listNewsletterDeliveries,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent(`/v1/newsletters/${deliveryNewsletter.id}/deliveries`, 'GET'),
    );

    expect(response.statusCode).toBe(403);
    expect(listNewsletterDeliveries).not.toHaveBeenCalled();
  });

  it('serves only sanitized opted-in directory fields without authentication', async () => {
    const listPublicDirectoryMembers = vi.fn().mockResolvedValue({
      items: [
        {
          ...owner,
          bio: 'Club builder',
          githubUrl: 'https://github.com/codehawk',
          linkedinUrl: 'https://linkedin.com@evil.example/in/fake',
          isPublicProfile: true,
          major: 'Computer Science',
          newsletterOptIn: true,
          techStack: ['TypeScript'],
        },
      ],
    });
    const ensureMember = vi.fn();
    const repository = {
      ensureMember,
      listPublicDirectoryMembers,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(event('/v1/directory/members'));

    expect(response.statusCode).toBe(200);
    expect(ensureMember).not.toHaveBeenCalled();
    const body = JSON.parse(response.body ?? '{}') as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toEqual({
      bio: 'Club builder',
      displayName: 'Owner',
      githubUrl: 'https://github.com/codehawk',
      handle: 'owner',
      major: 'Computer Science',
      minors: [],
      techStack: ['TypeScript'],
    });
  });

  it('keeps invitation search useful without leaking email, preferences, or activity times', async () => {
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      listMembers: vi.fn().mockResolvedValue({ items: [owner] }),
    } as unknown as ClubRepository;

    const request = authenticatedEvent('/v1/members', 'GET');
    request.queryStringParameters = { search: 'own' };
    const response = await createApi({ config, repository })(request);

    const item = (JSON.parse(response.body ?? '{}') as { data: Array<Record<string, unknown>> })
      .data[0];
    expect(item).toMatchObject({ id: owner.id, handle: owner.handle });
    for (const privateField of [
      'createdAt',
      'email',
      'identityProvider',
      'identitySubject',
      'isPublicProfile',
      'lastSeenAt',
      'newsletterOptIn',
      'status',
      'updatedAt',
    ]) {
      expect(item).not.toHaveProperty(privateField);
    }
  });

  it('rejects enumerable empty or short invitation searches', async () => {
    const listMembers = vi.fn();
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      listMembers,
    } as unknown as ClubRepository;
    const request = authenticatedEvent('/v1/members', 'GET');
    request.queryStringParameters = { search: 'ab' };

    const response = await createApi({ config, repository })(request);

    expect(response.statusCode).toBe(400);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('updates explicit privacy choices and a validated user-chosen handle', async () => {
    const updateMemberProfile = vi.fn().mockResolvedValue({
      ...owner,
      handle: 'code-hawk',
      isPublicProfile: true,
      newsletterOptIn: true,
    });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateMemberProfile,
    } as unknown as ClubRepository;

    const response = await createApi({ config, repository })(
      authenticatedEvent('/v1/me', 'PATCH', {
        handle: 'Code-Hawk',
        isPublicProfile: true,
        newsletterOptIn: true,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(updateMemberProfile).toHaveBeenCalledWith(owner, {
      handle: 'code-hawk',
      isPublicProfile: true,
      newsletterOptIn: true,
    });
  });

  it('rejects external and cross-member avatar URLs before storing them', async () => {
    const updateMemberProfile = vi.fn();
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateMemberProfile,
    } as unknown as ClubRepository;

    for (const avatarUrl of [
      'https://images.example.test/avatar.webp',
      'https://media.example.test/avatars/another-member/avatar.webp',
    ]) {
      const response = await createApi({ config, repository })(
        authenticatedEvent('/v1/me', 'PATCH', { avatarUrl }),
      );
      expect(response.statusCode).toBe(400);
    }
    expect(updateMemberProfile).not.toHaveBeenCalled();
  });

  it('attaches only the URL produced by server-side avatar finalization', async () => {
    const uploadId = '12345678-1234-4123-8123-123456789abc.webp';
    const publicUrl = `https://media.example.test/avatars/${owner.id}/${uploadId}`;
    const finalizeAvatarUpload = vi.fn().mockResolvedValue({ publicUrl });
    const updateMemberAvatar = vi.fn().mockResolvedValue({ ...owner, avatarUrl: publicUrl });
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateMemberAvatar,
    } as unknown as ClubRepository;
    const mediaService = { finalizeAvatarUpload } as unknown as MediaService;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent('/v1/me/avatar-upload/finalize', 'POST', { uploadId }),
    );

    expect(response.statusCode).toBe(200);
    expect(finalizeAvatarUpload).toHaveBeenCalledWith(owner, uploadId);
    expect(updateMemberAvatar).toHaveBeenCalledWith(owner, publicUrl);
  });

  it('deletes a losing finalized avatar when a concurrent profile update wins', async () => {
    const uploadId = '12345678-1234-4123-8123-123456789abc.webp';
    const publicUrl = `https://media.example.test/avatars/${owner.id}/${uploadId}`;
    const deleteManagedImage = vi.fn().mockResolvedValue(undefined);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(owner),
      updateMemberAvatar: vi.fn().mockRejectedValue(conflict('Avatar changed.')),
    } as unknown as ClubRepository;
    const mediaService = {
      deleteManagedImage,
      finalizeAvatarUpload: vi.fn().mockResolvedValue({ publicUrl }),
    } as unknown as MediaService;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent('/v1/me/avatar-upload/finalize', 'POST', { uploadId }),
    );

    expect(response.statusCode).toBe(409);
    expect(deleteManagedImage).toHaveBeenCalledOnce();
    expect(deleteManagedImage).toHaveBeenCalledWith(publicUrl, `avatars/${owner.id}/`);
  });

  it('removes the current avatar through an explicit cache-safe API operation', async () => {
    const memberWithAvatar = {
      ...owner,
      avatarUrl: `https://media.example.test/avatars/${owner.id}/old.webp`,
    };
    const updateMemberAvatar = vi.fn().mockResolvedValue({ ...owner });
    const deleteManagedImage = vi.fn().mockResolvedValue(undefined);
    const repository = {
      ensureMember: vi.fn().mockResolvedValue(memberWithAvatar),
      updateMemberAvatar,
    } as unknown as ClubRepository;
    const mediaService = { deleteManagedImage } as unknown as MediaService;

    const response = await createApi({ config, mediaService, repository })(
      authenticatedEvent('/v1/me/avatar', 'DELETE'),
    );

    expect(response.statusCode).toBe(200);
    expect(updateMemberAvatar).toHaveBeenCalledWith(memberWithAvatar, null);
    expect(deleteManagedImage).toHaveBeenCalledWith(
      memberWithAvatar.avatarUrl,
      `avatars/${owner.id}/`,
    );
  });

  it('exports and deletes only the authenticated member account', async () => {
    const privacyExport = {
      eventRsvps: [],
      generatedAt: '2026-08-23T00:00:00.000Z',
      invitations: [],
      limitations: [],
      memberships: [],
      notifications: [],
      profile: owner,
    };
    const exportMemberData = vi.fn().mockResolvedValue(privacyExport);
    const deleteMemberPersonalData = vi.fn().mockResolvedValue(undefined);
    const deleteMemberAvatar = vi.fn().mockResolvedValue(undefined);
    const repository = {
      deleteMemberPersonalData,
      ensureMember: vi.fn().mockResolvedValue(owner),
      exportMemberData,
    } as unknown as ClubRepository;
    const mediaService = { deleteMemberAvatar } as unknown as MediaService;
    const api = createApi({ config, mediaService, repository });

    const exportResponse = await api(authenticatedEvent('/v1/me/export', 'GET'));
    const deleteResponse = await api(authenticatedEvent('/v1/me', 'DELETE'));

    expect(exportResponse.statusCode).toBe(200);
    expect(JSON.parse(exportResponse.body ?? '{}')).toEqual({ data: privacyExport });
    expect(exportMemberData).toHaveBeenCalledWith(owner.id);
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteMemberAvatar).toHaveBeenCalledTimes(2);
    expect(deleteMemberAvatar).toHaveBeenNthCalledWith(1, owner);
    expect(deleteMemberAvatar).toHaveBeenNthCalledWith(2, owner);
    expect(deleteMemberPersonalData).toHaveBeenCalledWith(owner);
    expect(deleteMemberAvatar.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      deleteMemberPersonalData.mock.invocationCallOrder[0] ?? 0,
    );
    expect(deleteMemberPersonalData.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      deleteMemberAvatar.mock.invocationCallOrder[1] ?? 0,
    );
  });
});

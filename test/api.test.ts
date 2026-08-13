import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../src/api.js';
import type { AppConfig } from '../src/config.js';
import type { Member, Project, Team } from '../src/domain/entities.js';
import type { NewsletterQueue } from '../src/email/newsletter-queue.js';
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
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
  role: 'member',
  status: 'active',
  techStack: [],
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
    expect(body.data[0]).toMatchObject({ id: 'project-id', memberHandles: ['ada'] });
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
      fields: { key: `avatars/${owner.id}/avatar.webp` },
      publicUrl: `https://media.example.test/avatars/${owner.id}/avatar.webp`,
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
      fields: { key: `projects/${project.id}/image.webp` },
      publicUrl: `https://media.example.test/projects/${project.id}/image.webp`,
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

  it('creates a constrained team image upload for the team owner', async () => {
    const createResourceImageUpload = vi.fn().mockResolvedValue({
      fields: { key: `teams/${team.id}/image.png` },
      publicUrl: `https://media.example.test/teams/${team.id}/image.png`,
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
});

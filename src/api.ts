import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { ZodError, type ZodType } from 'zod';
import { identityFromEvent } from './auth/identity.js';
import {
  hasPermission,
  requireOwnerOrPermission,
  requirePermission,
} from './auth/permissions.js';
import type { AppConfig } from './config.js';
import {
  toPublicEvent,
  toPublicMember,
  toPublicProject,
  toPublicTeam,
  type ClubEvent,
  type Member,
  type Project,
  type Team,
} from './domain/entities.js';
import {
  createEventSchema,
  createNewsletterSchema,
  createProjectSchema,
  createTeamSchema,
  imageUploadSchema,
  inviteMemberSchema,
  memberAdministrationSchema,
  memberProfilePatchSchema,
  membershipStatusSchema,
  notificationReadSchema,
  projectStatusSchema,
  respondToInvitationSchema,
  reviewJoinRequestSchema,
  rsvpSchema,
  teamStatusSchema,
  transferOwnershipSchema,
  updateEventSchema,
  updateProjectSchema,
  updateTeamSchema,
} from './domain/schemas.js';
import { AppError, badRequest, conflict, forbidden, notFound } from './lib/errors.js';
import { json, noContent } from './lib/http.js';
import type { NewsletterQueue } from './email/newsletter-queue.js';
import type { MediaService } from './media/s3-media-service.js';
import type { ClubRepository } from './repositories/club-repository.js';

type ApiEvent = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer;

export interface ApiDependencies {
  config: AppConfig;
  mediaService?: MediaService;
  newsletterQueue?: NewsletterQueue;
  repository: ClubRepository;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 25;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequest('limit must be an integer between 1 and 100.');
  }
  return limit;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${name} must be true or false.`);
}

function parseBody<T>(event: ApiEvent, schema: ZodType<T>): T {
  if (!event.body) throw badRequest('A JSON request body is required.');
  let raw: unknown;
  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    raw = JSON.parse(body);
  } catch {
    throw badRequest('The request body must be valid JSON.');
  }
  return schema.parse(raw);
}

function pathMatch(path: string, pattern: RegExp): RegExpMatchArray | undefined {
  return path.match(pattern) ?? undefined;
}

async function requireProject(repository: ClubRepository, projectId: string): Promise<Project> {
  const project = await repository.getProject(projectId);
  if (!project) throw notFound('Project');
  return project;
}

async function requireTeam(repository: ClubRepository, teamId: string): Promise<Team> {
  const team = await repository.getTeam(teamId);
  if (!team) throw notFound('Team');
  return team;
}

async function requireEvent(repository: ClubRepository, eventId: string): Promise<ClubEvent> {
  const event = await repository.getEvent(eventId);
  if (!event) throw notFound('Event');
  return event;
}

function assertActive(member: Member, path: string, method: string): void {
  if (member.status === 'suspended' && !(path === '/v1/me' && method === 'GET')) {
    throw forbidden('This club account is suspended.');
  }
}

function publicRoutes(
  event: ApiEvent,
  repository: ClubRepository,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/$/, '') || '/';
  const query = event.queryStringParameters ?? {};

  if (method === 'OPTIONS' && (path === '/v1' || path.startsWith('/v1/'))) {
    return Promise.resolve(noContent());
  }

  if (method === 'GET' && path === '/health') {
    return Promise.resolve(
      json(200, {
        data: { service: 'clubwebsite-backend', status: 'ok', timestamp: new Date().toISOString() },
      }),
    );
  }

  if (method === 'GET' && path === '/v1/projects') {
    return repository.listProjects(parseLimit(query.limit), query.cursor).then((page) =>
      json(200, {
        data: page.items.map(toPublicProject),
        meta: { nextCursor: page.nextCursor ?? null },
      }),
    );
  }
  const projectMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)$/i);
  if (method === 'GET' && projectMatch?.[1]) {
    return requireProject(repository, projectMatch[1]).then((project) => {
      if (project.status !== 'published') throw notFound('Project');
      return json(200, { data: toPublicProject(project) });
    });
  }

  if (method === 'GET' && path === '/v1/teams') {
    return repository.listTeams(parseLimit(query.limit), query.cursor).then((page) =>
      json(200, {
        data: page.items.map(toPublicTeam),
        meta: { nextCursor: page.nextCursor ?? null },
      }),
    );
  }
  const teamMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)$/i);
  if (method === 'GET' && teamMatch?.[1]) {
    return requireTeam(repository, teamMatch[1]).then((team) => {
      if (team.status === 'archived') throw notFound('Team');
      return json(200, { data: toPublicTeam(team) });
    });
  }

  if (method === 'GET' && path === '/v1/events') {
    return repository.listEvents(parseLimit(query.limit), query.cursor).then((page) =>
      json(200, {
        data: page.items.map(toPublicEvent),
        meta: { nextCursor: page.nextCursor ?? null },
      }),
    );
  }
  const eventMatch = pathMatch(path, /^\/v1\/events\/([0-9a-f-]+)$/i);
  if (method === 'GET' && eventMatch?.[1]) {
    return requireEvent(repository, eventMatch[1]).then((clubEvent) => {
      if (!clubEvent.published) throw notFound('Event');
      return json(200, { data: toPublicEvent(clubEvent) });
    });
  }

  return Promise.resolve(undefined);
}

async function authenticatedRoutes(
  event: ApiEvent,
  repository: ClubRepository,
  actor: Member,
  mediaService?: MediaService,
  newsletterQueue?: NewsletterQueue,
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/$/, '') || '/';
  const query = event.queryStringParameters ?? {};

  if (path === '/v1/me' && method === 'GET') {
    return json(200, { data: actor });
  }
  if (path === '/v1/me' && method === 'PATCH') {
    const input = parseBody(event, memberProfilePatchSchema);
    return json(200, { data: await repository.updateMemberProfile(actor, input) });
  }
  if (path === '/v1/me/avatar-upload' && method === 'POST') {
    if (!mediaService) {
      throw new Error('The media service is not configured.');
    }
    const input = parseBody(event, imageUploadSchema);
    return json(201, { data: await mediaService.createAvatarUpload(actor, input) });
  }
  if (path === '/v1/me/notifications' && method === 'GET') {
    const page = await repository.listMemberNotifications(
      actor.id,
      parseOptionalBoolean(query.read, 'read'),
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }
  const notificationMatch = pathMatch(
    path,
    /^\/v1\/me\/notifications\/([0-9]{13}-[0-9a-f-]{36})$/i,
  );
  if (notificationMatch?.[1] && method === 'PATCH') {
    const input = parseBody(event, notificationReadSchema);
    return json(200, {
      data: await repository.updateNotificationReadState(
        actor.id,
        notificationMatch[1],
        input.read,
      ),
    });
  }

  if (path === '/v1/members' && method === 'GET') {
    const page = await repository.listMembers(query.search ?? '', parseLimit(query.limit), query.cursor);
    return json(200, {
      data: page.items.map(toPublicMember),
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/me/invitations' && method === 'GET') {
    const page = await repository.listMemberInvitations(
      actor.id,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/me/memberships' && method === 'GET') {
    const resourceType = query.resourceType;
    if (
      resourceType !== undefined &&
      resourceType !== 'project' &&
      resourceType !== 'team'
    ) {
      throw badRequest('resourceType must be project or team.');
    }
    const status = query.status ? membershipStatusSchema.parse(query.status) : undefined;
    const page = await repository.listMemberResourceMemberships(
      actor.id,
      resourceType,
      status,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/manage/projects' && method === 'GET') {
    requirePermission(actor, 'projects.manage');
    const status = query.status ? projectStatusSchema.parse(query.status) : undefined;
    const page = await repository.listManagedProjects(
      status,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/manage/teams' && method === 'GET') {
    requirePermission(actor, 'teams.manage');
    const status = query.status ? teamStatusSchema.parse(query.status) : undefined;
    const page = await repository.listManagedTeams(
      status,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/manage/events' && method === 'GET') {
    requirePermission(actor, 'events.manage');
    const page = await repository.listManagedEvents(parseLimit(query.limit), query.cursor);
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  if (path === '/v1/newsletters' && method === 'POST') {
    requirePermission(actor, 'newsletters.send');
    if (!newsletterQueue) throw new Error('The newsletter queue is not configured.');
    const newsletter = await repository.createNewsletter(
      actor,
      parseBody(event, createNewsletterSchema),
    );
    if (newsletter.status === 'queued') {
      try {
        await newsletterQueue.startNewsletter(newsletter.id);
      } catch (error) {
        await repository.updateNewsletterStatus(newsletter.id, 'queued', 'queue_failed');
        throw error;
      }
    }
    return json(202, { data: newsletter });
  }

  if (path === '/v1/newsletters' && method === 'GET') {
    requirePermission(actor, 'newsletters.send');
    const page = await repository.listNewsletters(parseLimit(query.limit), query.cursor);
    return json(200, {
      data: page.items,
      meta: { nextCursor: page.nextCursor ?? null },
    });
  }

  const newsletterMatch = pathMatch(path, /^\/v1\/newsletters\/([0-9a-f-]+)$/i);
  if (newsletterMatch?.[1] && method === 'GET') {
    requirePermission(actor, 'newsletters.send');
    const newsletter = await repository.getNewsletter(newsletterMatch[1]);
    if (!newsletter) throw notFound('Newsletter');
    return json(200, { data: newsletter });
  }

  const newsletterRetryMatch = pathMatch(
    path,
    /^\/v1\/newsletters\/([0-9a-f-]+)\/retry$/i,
  );
  if (newsletterRetryMatch?.[1] && method === 'POST') {
    requirePermission(actor, 'newsletters.send');
    if (!newsletterQueue) throw new Error('The newsletter queue is not configured.');
    const newsletter = await repository.updateNewsletterStatus(
      newsletterRetryMatch[1],
      'queue_failed',
      'queued',
    );
    try {
      await newsletterQueue.startNewsletter(newsletter.id);
    } catch (error) {
      await repository.updateNewsletterStatus(newsletter.id, 'queued', 'queue_failed');
      throw error;
    }
    return json(202, { data: newsletter });
  }

  const memberAdminMatch = pathMatch(path, /^\/v1\/members\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && memberAdminMatch?.[1]) {
    const input = parseBody(event, memberAdministrationSchema);
    const target = await repository.getMember(memberAdminMatch[1]);
    if (!target) throw notFound('Member');
    if (input.role !== undefined) requirePermission(actor, 'roles.manage');
    if (input.status !== undefined) requirePermission(actor, 'members.manage');
    if (target.role === 'president' && actor.role !== 'president') throw forbidden();
    if (target.id === actor.id && input.status === 'suspended') {
      throw badRequest('You cannot suspend your own account.');
    }
    const changes = {
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.status === undefined ? {} : { status: input.status }),
    };
    return json(200, { data: await repository.administerMember(target.id, changes) });
  }

  if (path === '/v1/projects' && method === 'POST') {
    const input = parseBody(event, createProjectSchema);
    return json(201, { data: await repository.createProject(actor, input) });
  }
  const projectMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)$/i);
  if (projectMatch?.[1] && method === 'PATCH') {
    const project = await requireProject(repository, projectMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, updateProjectSchema);
    if (input.status === 'published' && !hasPermission(actor, 'projects.manage')) {
      throw forbidden('An officer must publish a project.');
    }
    return json(200, { data: await repository.updateProject(project, input) });
  }
  const projectManageMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)\/manage$/i);
  if (projectManageMatch?.[1] && method === 'GET') {
    const project = await requireProject(repository, projectManageMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    return json(200, { data: project });
  }
  const projectImageUploadMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/image-upload$/i,
  );
  if (projectImageUploadMatch?.[1] && method === 'POST') {
    if (!mediaService) throw new Error('The media service is not configured.');
    const project = await requireProject(repository, projectImageUploadMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, imageUploadSchema);
    return json(201, {
      data: await mediaService.createResourceImageUpload('project', project.id, input),
    });
  }
  if (projectMatch?.[1] && method === 'DELETE') {
    const project = await requireProject(repository, projectMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    await repository.archiveProject(project);
    return noContent();
  }
  const projectJoinMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)\/join-requests$/i);
  if (projectJoinMatch?.[1] && method === 'POST') {
    const project = await requireProject(repository, projectJoinMatch[1]);
    return json(200, { data: { status: await repository.requestProjectMembership(project, actor) } });
  }
  const projectWithdrawMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/join-requests\/me$/i,
  );
  if (projectWithdrawMatch?.[1] && method === 'DELETE') {
    const project = await requireProject(repository, projectWithdrawMatch[1]);
    await repository.withdrawResourceRequest('project', project, actor);
    return noContent();
  }
  const projectReviewMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/join-requests\/([0-9a-f-]+)$/i,
  );
  if (projectReviewMatch?.[1] && projectReviewMatch[2] && method === 'PATCH') {
    const project = await requireProject(repository, projectReviewMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, reviewJoinRequestSchema);
    return json(200, {
      data: await repository.reviewProjectMembership(
        project,
        actor,
        projectReviewMatch[2],
        input.status,
      ),
    });
  }
  const projectMembershipsMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/memberships$/i,
  );
  if (projectMembershipsMatch?.[1] && method === 'GET') {
    const project = await requireProject(repository, projectMembershipsMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const status = membershipStatusSchema.parse(query.status ?? 'requested');
    const page = await repository.listResourceMemberships(
      'project',
      project.id,
      status,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, { data: page.items, meta: { nextCursor: page.nextCursor ?? null } });
  }
  const projectInvitationsMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/invitations$/i,
  );
  if (projectInvitationsMatch?.[1] && method === 'POST') {
    const project = await requireProject(repository, projectInvitationsMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, inviteMemberSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    await repository.inviteResourceMember('project', project, actor, target);
    return json(201, { data: { status: 'invited' } });
  }
  const projectMembersMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)\/members$/i);
  if (projectMembersMatch?.[1] && method === 'POST') {
    const project = await requireProject(repository, projectMembersMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, inviteMemberSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    return json(200, {
      data: await repository.addResourceMember('project', project, actor, target),
    });
  }
  const projectRevokeInvitationMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/invitations\/([0-9a-f-]+)$/i,
  );
  if (
    projectRevokeInvitationMatch?.[1] &&
    projectRevokeInvitationMatch[2] &&
    method === 'DELETE'
  ) {
    const project = await requireProject(repository, projectRevokeInvitationMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    await repository.revokeResourceInvitation(
      'project',
      project.id,
      actor,
      projectRevokeInvitationMatch[2],
    );
    return noContent();
  }
  const projectInvitationMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/invitation$/i,
  );
  if (projectInvitationMatch?.[1] && method === 'PATCH') {
    const project = await requireProject(repository, projectInvitationMatch[1]);
    const input = parseBody(event, respondToInvitationSchema);
    return json(200, {
      data: await repository.respondToResourceInvitation(
        'project',
        project,
        actor,
        input.response,
      ),
    });
  }
  const projectLeaveMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/members\/me$/i,
  );
  if (projectLeaveMatch?.[1] && method === 'DELETE') {
    const project = await requireProject(repository, projectLeaveMatch[1]);
    return json(200, {
      data: await repository.removeResourceMember('project', project, actor, actor.id, 'left'),
    });
  }
  const projectMemberMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/i,
  );
  if (projectMemberMatch?.[1] && projectMemberMatch[2] && method === 'DELETE') {
    const project = await requireProject(repository, projectMemberMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    if (projectMemberMatch[2] === actor.id) {
      throw badRequest('Use the /members/me route to leave a project.');
    }
    return json(200, {
      data: await repository.removeResourceMember(
        'project',
        project,
        actor,
        projectMemberMatch[2],
        'removed',
      ),
    });
  }
  const projectOwnerMatch = pathMatch(path, /^\/v1\/projects\/([0-9a-f-]+)\/owner$/i);
  if (projectOwnerMatch?.[1] && method === 'PATCH') {
    const project = await requireProject(repository, projectOwnerMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const input = parseBody(event, transferOwnershipSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    return json(200, {
      data: await repository.transferResourceOwnership('project', project, actor, target),
    });
  }
  const projectAuditMatch = pathMatch(
    path,
    /^\/v1\/projects\/([0-9a-f-]+)\/membership-audit$/i,
  );
  if (projectAuditMatch?.[1] && method === 'GET') {
    const project = await requireProject(repository, projectAuditMatch[1]);
    requireOwnerOrPermission(actor, project.ownerId, 'projects.manage');
    const page = await repository.listMembershipAudit(
      'project',
      project.id,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, { data: page.items, meta: { nextCursor: page.nextCursor ?? null } });
  }

  if (path === '/v1/teams' && method === 'POST') {
    const input = parseBody(event, createTeamSchema);
    return json(201, { data: await repository.createTeam(actor, input) });
  }
  const teamMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)$/i);
  if (teamMatch?.[1] && method === 'PATCH') {
    const team = await requireTeam(repository, teamMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, updateTeamSchema);
    if (input.maxMembers !== undefined && input.maxMembers < team.memberCount) {
      throw badRequest('maxMembers cannot be lower than the current member count.');
    }
    return json(200, { data: await repository.updateTeam(team, input) });
  }
  const teamManageMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/manage$/i);
  if (teamManageMatch?.[1] && method === 'GET') {
    const team = await requireTeam(repository, teamManageMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    return json(200, { data: team });
  }
  const teamImageUploadMatch = pathMatch(
    path,
    /^\/v1\/teams\/([0-9a-f-]+)\/image-upload$/i,
  );
  if (teamImageUploadMatch?.[1] && method === 'POST') {
    if (!mediaService) throw new Error('The media service is not configured.');
    const team = await requireTeam(repository, teamImageUploadMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, imageUploadSchema);
    return json(201, {
      data: await mediaService.createResourceImageUpload('team', team.id, input),
    });
  }
  if (teamMatch?.[1] && method === 'DELETE') {
    const team = await requireTeam(repository, teamMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    await repository.archiveTeam(team);
    return noContent();
  }
  const teamJoinMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/join-requests$/i);
  if (teamJoinMatch?.[1] && method === 'POST') {
    const team = await requireTeam(repository, teamJoinMatch[1]);
    return json(200, { data: { status: await repository.requestTeamMembership(team, actor) } });
  }
  const teamWithdrawMatch = pathMatch(
    path,
    /^\/v1\/teams\/([0-9a-f-]+)\/join-requests\/me$/i,
  );
  if (teamWithdrawMatch?.[1] && method === 'DELETE') {
    const team = await requireTeam(repository, teamWithdrawMatch[1]);
    await repository.withdrawResourceRequest('team', team, actor);
    return noContent();
  }
  const teamReviewMatch = pathMatch(
    path,
    /^\/v1\/teams\/([0-9a-f-]+)\/join-requests\/([0-9a-f-]+)$/i,
  );
  if (teamReviewMatch?.[1] && teamReviewMatch[2] && method === 'PATCH') {
    const team = await requireTeam(repository, teamReviewMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, reviewJoinRequestSchema);
    return json(200, {
      data: await repository.reviewTeamMembership(team, actor, teamReviewMatch[2], input.status),
    });
  }
  const teamMembershipsMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/memberships$/i);
  if (teamMembershipsMatch?.[1] && method === 'GET') {
    const team = await requireTeam(repository, teamMembershipsMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const status = membershipStatusSchema.parse(query.status ?? 'requested');
    const page = await repository.listResourceMemberships(
      'team',
      team.id,
      status,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, { data: page.items, meta: { nextCursor: page.nextCursor ?? null } });
  }
  const teamInvitationsMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/invitations$/i);
  if (teamInvitationsMatch?.[1] && method === 'POST') {
    const team = await requireTeam(repository, teamInvitationsMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, inviteMemberSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    await repository.inviteResourceMember('team', team, actor, target);
    return json(201, { data: { status: 'invited' } });
  }
  const teamMembersMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/members$/i);
  if (teamMembersMatch?.[1] && method === 'POST') {
    const team = await requireTeam(repository, teamMembersMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, inviteMemberSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    return json(200, {
      data: await repository.addResourceMember('team', team, actor, target),
    });
  }
  const teamRevokeInvitationMatch = pathMatch(
    path,
    /^\/v1\/teams\/([0-9a-f-]+)\/invitations\/([0-9a-f-]+)$/i,
  );
  if (teamRevokeInvitationMatch?.[1] && teamRevokeInvitationMatch[2] && method === 'DELETE') {
    const team = await requireTeam(repository, teamRevokeInvitationMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    await repository.revokeResourceInvitation(
      'team',
      team.id,
      actor,
      teamRevokeInvitationMatch[2],
    );
    return noContent();
  }
  const teamInvitationMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/invitation$/i);
  if (teamInvitationMatch?.[1] && method === 'PATCH') {
    const team = await requireTeam(repository, teamInvitationMatch[1]);
    const input = parseBody(event, respondToInvitationSchema);
    return json(200, {
      data: await repository.respondToResourceInvitation('team', team, actor, input.response),
    });
  }
  const teamLeaveMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/members\/me$/i);
  if (teamLeaveMatch?.[1] && method === 'DELETE') {
    const team = await requireTeam(repository, teamLeaveMatch[1]);
    return json(200, {
      data: await repository.removeResourceMember('team', team, actor, actor.id, 'left'),
    });
  }
  const teamMemberMatch = pathMatch(
    path,
    /^\/v1\/teams\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/i,
  );
  if (teamMemberMatch?.[1] && teamMemberMatch[2] && method === 'DELETE') {
    const team = await requireTeam(repository, teamMemberMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    if (teamMemberMatch[2] === actor.id) {
      throw badRequest('Use the /members/me route to leave a team.');
    }
    return json(200, {
      data: await repository.removeResourceMember(
        'team',
        team,
        actor,
        teamMemberMatch[2],
        'removed',
      ),
    });
  }
  const teamOwnerMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/owner$/i);
  if (teamOwnerMatch?.[1] && method === 'PATCH') {
    const team = await requireTeam(repository, teamOwnerMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const input = parseBody(event, transferOwnershipSchema);
    const target = await repository.getMember(input.memberId);
    if (!target) throw notFound('Member');
    return json(200, {
      data: await repository.transferResourceOwnership('team', team, actor, target),
    });
  }
  const teamAuditMatch = pathMatch(path, /^\/v1\/teams\/([0-9a-f-]+)\/membership-audit$/i);
  if (teamAuditMatch?.[1] && method === 'GET') {
    const team = await requireTeam(repository, teamAuditMatch[1]);
    requireOwnerOrPermission(actor, team.ownerId, 'teams.manage');
    const page = await repository.listMembershipAudit(
      'team',
      team.id,
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, { data: page.items, meta: { nextCursor: page.nextCursor ?? null } });
  }

  if (path === '/v1/events' && method === 'POST') {
    requirePermission(actor, 'events.manage');
    return json(201, { data: await repository.createEvent(actor, parseBody(event, createEventSchema)) });
  }
  const eventMatch = pathMatch(path, /^\/v1\/events\/([0-9a-f-]+)$/i);
  if (eventMatch?.[1] && method === 'PATCH') {
    requirePermission(actor, 'events.manage');
    const clubEvent = await requireEvent(repository, eventMatch[1]);
    const input = parseBody(event, updateEventSchema);
    const startsAt = input.startsAt ?? clubEvent.startsAt;
    const endsAt = input.endsAt ?? clubEvent.endsAt;
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw badRequest('endsAt must be later than startsAt.');
    }
    return json(200, { data: await repository.updateEvent(clubEvent, input) });
  }
  const eventManageMatch = pathMatch(path, /^\/v1\/events\/([0-9a-f-]+)\/manage$/i);
  if (eventManageMatch?.[1] && method === 'GET') {
    requirePermission(actor, 'events.manage');
    return json(200, { data: await requireEvent(repository, eventManageMatch[1]) });
  }
  if (eventMatch?.[1] && method === 'DELETE') {
    requirePermission(actor, 'events.manage');
    const clubEvent = await requireEvent(repository, eventMatch[1]);
    await repository.archiveEvent(clubEvent);
    return noContent();
  }
  const rsvpMatch = pathMatch(path, /^\/v1\/events\/([0-9a-f-]+)\/rsvp$/i);
  if (rsvpMatch?.[1] && method === 'PUT') {
    const clubEvent = await requireEvent(repository, rsvpMatch[1]);
    if (clubEvent.archived || !clubEvent.published) {
      throw conflict('This event is not accepting RSVPs.');
    }
    await repository.setEventRsvp(clubEvent, actor, parseBody(event, rsvpSchema).status);
    return noContent();
  }
  if (rsvpMatch?.[1] && method === 'DELETE') {
    const clubEvent = await requireEvent(repository, rsvpMatch[1]);
    if (clubEvent.archived || !clubEvent.published) {
      throw conflict('This event is not accepting RSVP changes.');
    }
    await repository.removeEventRsvp(clubEvent, actor);
    return noContent();
  }
  const rsvpsMatch = pathMatch(path, /^\/v1\/events\/([0-9a-f-]+)\/rsvps$/i);
  if (rsvpsMatch?.[1] && method === 'GET') {
    requirePermission(actor, 'events.manage');
    await requireEvent(repository, rsvpsMatch[1]);
    const page = await repository.listEventRsvps(
      rsvpsMatch[1],
      parseLimit(query.limit),
      query.cursor,
    );
    return json(200, { data: page.items, meta: { nextCursor: page.nextCursor ?? null } });
  }

  throw notFound('Route');
}

export function createApi(dependencies: ApiDependencies) {
  return async (event: ApiEvent): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = event.requestContext.requestId;
    try {
      const publicResult = await publicRoutes(event, dependencies.repository);
      if (publicResult) return publicResult;

      const identity = identityFromEvent(
        event as APIGatewayProxyEventV2WithJWTAuthorizer,
        dependencies.config,
      );
      const actor = await dependencies.repository.ensureMember(identity);
      assertActive(actor, event.rawPath, event.requestContext.http.method);
      return await authenticatedRoutes(
        event,
        dependencies.repository,
        actor,
        dependencies.mediaService,
        dependencies.newsletterQueue,
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return json(400, {
          error: {
            code: 'validation_failed',
            details: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
            message: 'The request did not pass validation.',
            requestId,
          },
        });
      }
      if (error instanceof AppError) {
        return json(error.statusCode, {
          error: {
            code: error.code,
            ...(error.details === undefined ? {} : { details: error.details }),
            message: error.message,
            requestId,
          },
        });
      }

      console.error(
        JSON.stringify({
          error: error instanceof Error ? { message: error.message, name: error.name } : 'Unknown error',
          level: 'error',
          requestId,
        }),
      );
      return json(500, {
        error: { code: 'internal_error', message: 'An unexpected error occurred.', requestId },
      });
    }
  };
}

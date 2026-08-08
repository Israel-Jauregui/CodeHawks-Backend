import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type NativeAttributeValue,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type {
  AuthenticatedIdentity,
  ClubEvent,
  ClubRole,
  EventRsvp,
  JoinRequestStatus,
  Member,
  MemberStatus,
  MembershipAuditEntry,
  MembershipInvitation,
  MembershipStatus,
  Newsletter,
  NewsletterStatus,
  Notification,
  Page,
  PublicationStatus,
  Project,
  ResourceMembership,
  ResourceType,
  Team,
  TeamStatus,
} from '../domain/entities.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type {
  ClubRepository,
  CreateEventInput,
  CreateNewsletterInput,
  CreateProjectInput,
  CreateTeamInput,
  UpdateEventInput,
  UpdateMemberProfileInput,
  UpdateProjectInput,
  UpdateTeamInput,
} from './club-repository.js';

type Item = Record<string, NativeAttributeValue>;
type EntityKind = 'EVENT' | 'NEWSLETTER' | 'PROJECT' | 'TEAM';
type ManagedResource = Project | Team;
type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type TransactionPut = NonNullable<TransactionItem['Put']>;
type TransactionUpdate = NonNullable<TransactionItem['Update']>;

function now(): string {
  return new Date().toISOString();
}

function key(prefix: string, id: string): string {
  return `${prefix}#${id}`;
}

function profileKey(memberId: string): Record<'pk' | 'sk', string> {
  return { pk: key('USER', memberId), sk: 'PROFILE' };
}

function identityKey(identity: AuthenticatedIdentity): Record<'pk' | 'sk', string> {
  return { pk: `IDENTITY#${identity.provider}#${identity.subject}`, sk: 'LOOKUP' };
}

function emailLookupKey(email: string): Record<'pk' | 'sk', string> {
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return { pk: key('EMAIL', digest), sk: 'LOOKUP' };
}

function entityKey(kind: EntityKind, id: string): Record<'pk' | 'sk', string> {
  return { pk: key(kind, id), sk: 'METADATA' };
}

function resourceKind(resourceType: ResourceType): 'PROJECT' | 'TEAM' {
  return resourceType === 'project' ? 'PROJECT' : 'TEAM';
}

function membershipKey(
  resourceType: ResourceType,
  resourceId: string,
  memberId: string,
): Record<'pk' | 'sk', string> {
  return {
    pk: key(resourceKind(resourceType), resourceId),
    sk: key('MEMBER', memberId),
  };
}

function invitationKey(
  memberId: string,
  resourceType: ResourceType,
  resourceId: string,
): Record<'pk' | 'sk', string> {
  return {
    pk: key('USER', memberId),
    sk: `INVITE#${resourceType.toUpperCase()}#${resourceId}`,
  };
}

function newsletterDeliveryKey(
  newsletterId: string,
  memberId: string,
): Record<'pk' | 'sk', string> {
  return {
    pk: key('NEWSLETTER', newsletterId),
    sk: key('DELIVERY', memberId),
  };
}

function membershipIndex(
  memberId: string,
  resourceType: ResourceType,
  resourceId: string,
): Record<'gsi2pk' | 'gsi2sk', string> {
  return {
    gsi2pk: key('USER', memberId),
    gsi2sk: `RESOURCE#${resourceType.toUpperCase()}#${resourceId}`,
  };
}

function notificationKey(
  memberId: string,
  notificationId: string,
): Record<'pk' | 'sk', string> {
  return {
    pk: key('USER', memberId),
    sk: key('NOTIFICATION', notificationId),
  };
}

function auditPut(
  tableName: string,
  resourceType: ResourceType,
  resourceId: string,
  action: MembershipAuditEntry['action'],
  actorId: string,
  targetMemberId: string,
  timestamp: string,
): TransactionPut {
  const audit: MembershipAuditEntry = {
    action,
    actorId,
    createdAt: timestamp,
    id: randomUUID(),
    resourceId,
    resourceType,
    targetMemberId,
  };
  return {
    Item: {
      ...audit,
      entityType: 'MembershipAudit',
      pk: key(resourceKind(resourceType), resourceId),
      sk: `AUDIT#${timestamp}#${audit.id}`,
    },
    TableName: tableName,
  };
}

type JoinNotificationAction = 'requested' | 'withdrawn' | 'approved' | 'rejected';

function joinNotificationPut(
  tableName: string,
  recipientId: string,
  action: JoinNotificationAction,
  actor: Member,
  resourceType: ResourceType,
  resource: ManagedResource,
  timestamp: string,
): TransactionPut {
  const id = `${String(Date.parse(timestamp)).padStart(13, '0')}-${randomUUID()}`;
  const resourceLabel = resourceType === 'project' ? 'project' : 'team';
  const content: Record<
    JoinNotificationAction,
    Pick<Notification, 'message' | 'title' | 'type'>
  > = {
    approved: {
      message: `${actor.displayName} approved your request to join ${resource.name}.`,
      title: 'Join request approved',
      type: 'resource_join_approved',
    },
    rejected: {
      message: `${actor.displayName} declined your request to join ${resource.name}.`,
      title: 'Join request declined',
      type: 'resource_join_rejected',
    },
    requested: {
      message: `${actor.displayName} requested to join your ${resourceLabel}, ${resource.name}.`,
      title: `New ${resourceLabel} join request`,
      type: 'resource_join_requested',
    },
    withdrawn: {
      message: `${actor.displayName} withdrew their request to join ${resource.name}.`,
      title: 'Join request withdrawn',
      type: 'resource_join_withdrawn',
    },
  };
  const notification: Notification = {
    actorDisplayName: actor.displayName,
    actorHandle: actor.handle,
    actorId: actor.id,
    createdAt: timestamp,
    id,
    message: content[action].message,
    resourceId: resource.id,
    resourceName: resource.name,
    resourceType,
    title: content[action].title,
    type: content[action].type,
  };
  return {
    ConditionExpression: 'attribute_not_exists(pk)',
    Item: {
      ...notificationKey(recipientId, id),
      ...notification,
      entityType: 'Notification',
      gsi2pk: key('USER', recipientId),
      gsi2sk: key('NOTIFICATION', id),
    },
    TableName: tableName,
  };
}

function handleFromEmail(email: string): string {
  const localPart = email.slice(0, email.lastIndexOf('@'));
  const normalized = localPart.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);
  return normalized || `member-${randomUUID().slice(0, 8)}`;
}

function normalizeMember(member: Member): Member {
  return {
    ...member,
    minors: member.minors ?? [],
    techStack: member.techStack ?? [],
  };
}

function withoutStorageKeys<T>(item: Item | undefined): T | undefined {
  if (!item) return undefined;
  const {
    entityType: _entityType,
    gsi1pk: _gsi1pk,
    gsi1sk: _gsi1sk,
    gsi2pk: _gsi2pk,
    gsi2sk: _gsi2sk,
    pk: _pk,
    sk: _sk,
    ...entity
  } = item;
  return entity as T;
}

function encodeCursor(lastKey: Record<string, NativeAttributeValue> | undefined): string | undefined {
  return lastKey
    ? Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64url')
    : undefined;
}

function decodeCursor(cursor: string | undefined): Record<string, NativeAttributeValue> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
    return decoded as Record<string, NativeAttributeValue>;
  } catch {
    throw badRequest('The pagination cursor is invalid.');
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException')
  );
}

function withOptional<T extends object>(value: T): T {
  return value;
}

interface UpdateParts {
  expression: string;
  names: Record<string, string>;
  values: Record<string, NativeAttributeValue>;
}

function buildUpdate(patch: Record<string, unknown>): UpdateParts {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, NativeAttributeValue> = {};
  let index = 0;

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const nameKey = `#field${index}`;
    names[nameKey] = field;
    if (value === null) {
      removes.push(nameKey);
    } else {
      const valueKey = `:value${index}`;
      // The AWS SDK intentionally exposes DynamoDB document values through a
      // permissive union. Inputs have already passed the route's Zod schema.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      values[valueKey] = value as NativeAttributeValue;
      sets.push(`${nameKey} = ${valueKey}`);
    }
    index += 1;
  }

  const expression = [
    sets.length > 0 ? `SET ${sets.join(', ')}` : '',
    removes.length > 0 ? `REMOVE ${removes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { expression, names, values };
}

export class DynamoClubRepository implements ClubRepository {
  public constructor(
    private readonly tableName: string,
    private readonly documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
      { marshallOptions: { removeUndefinedValues: true } },
    ),
  ) {}

  public async ensureMember(identity: AuthenticatedIdentity): Promise<Member> {
    const identityLookup = await this.getRaw(identityKey(identity));
    const existingMemberId =
      typeof identityLookup?.memberId === 'string' ? identityLookup.memberId : undefined;
    const existing = existingMemberId ? await this.getMember(existingMemberId) : undefined;
    const timestamp = now();

    if (existing) {
      if (existing.email !== identity.email) {
        throw conflict(
          'The verified email on this identity changed. An officer must review the account before relinking it.',
        );
      }
      const result = await this.documentClient.send(
        new UpdateCommand({
          ExpressionAttributeValues: {
            ':lastSeenAt': timestamp,
            ':updatedAt': timestamp,
          },
          Key: profileKey(existing.id),
          ReturnValues: 'ALL_NEW',
          TableName: this.tableName,
          UpdateExpression: 'SET lastSeenAt = :lastSeenAt, updatedAt = :updatedAt',
        }),
      );
      return normalizeMember(withoutStorageKeys<Member>(result.Attributes as Item) as Member);
    }

    if (existingMemberId) {
      throw new Error('Identity lookup points to a missing member profile.');
    }

    const handle = handleFromEmail(identity.email);
    const member: Member = {
      createdAt: timestamp,
      displayName: identity.displayName,
      email: identity.email,
      handle,
      id: randomUUID(),
      identityProvider: identity.provider,
      identitySubject: identity.subject,
      ...(identity.tenantId ? { identityTenant: identity.tenantId } : {}),
      lastSeenAt: timestamp,
      minors: [],
      role: 'member',
      status: 'active',
      techStack: [],
      updatedAt: timestamp,
    };

    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...profileKey(member.id),
                  ...member,
                  entityType: 'Member',
                  gsi1pk: 'MEMBERS',
                  gsi1sk: `HANDLE#${handle}#${member.id}`,
                },
                TableName: this.tableName,
              },
            },
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...identityKey(identity),
                  entityType: 'IdentityLookup',
                  memberId: member.id,
                },
                TableName: this.tableName,
              },
            },
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  entityType: 'HandleLookup',
                  memberId: member.id,
                  pk: key('HANDLE', handle),
                  sk: 'LOOKUP',
                },
                TableName: this.tableName,
              },
            },
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...emailLookupKey(identity.email),
                  entityType: 'EmailLookup',
                  memberId: member.id,
                },
                TableName: this.tableName,
              },
            },
          ],
        }),
      );
      return member;
    } catch (error) {
      if (isConditionalFailure(error)) {
        const racedLookup = await this.getRaw(identityKey(identity));
        const racedMemberId =
          typeof racedLookup?.memberId === 'string' ? racedLookup.memberId : undefined;
        const racedMember = racedMemberId ? await this.getMember(racedMemberId) : undefined;
        if (racedMember) return racedMember;
        throw conflict('A club profile already uses this school email or handle.');
      }
      throw error;
    }
  }

  public async getMember(memberId: string): Promise<Member | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({ Key: profileKey(memberId), TableName: this.tableName }),
    );
    const member = withoutStorageKeys<Member>(result.Item as Item | undefined);
    return member ? normalizeMember(member) : undefined;
  }

  public async listMembers(
    search: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Member>> {
    const normalizedSearch = search.trim().toLowerCase();
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeValues: {
          ':partition': 'MEMBERS',
          ':prefix': `HANDLE#${normalizedSearch}`,
        },
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :partition AND begins_with(gsi1sk, :prefix)',
        Limit: limit,
        TableName: this.tableName,
      }),
    );

    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<Member>(item as Item))
      .filter((item): item is Member => item !== undefined && item.status === 'active')
      .map(normalizeMember);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  public async updateMemberProfile(
    member: Member,
    patch: UpdateMemberProfileInput,
  ): Promise<Member> {
    return normalizeMember(
      await this.updateAndReturn<Member>(profileKey(member.id), { ...patch, updatedAt: now() }),
    );
  }

  public async administerMember(
    memberId: string,
    changes: { role?: ClubRole; status?: MemberStatus },
  ): Promise<Member> {
    const existing = await this.getMember(memberId);
    if (!existing) throw notFound('Member');
    return normalizeMember(
      await this.updateAndReturn<Member>(profileKey(memberId), { ...changes, updatedAt: now() }),
    );
  }

  public async listMemberNotifications(
    memberId: string,
    read: boolean | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Notification>> {
    const unreadOnly = read === false;
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ...(read === true ? { FilterExpression: 'attribute_exists(readAt)' } : {}),
        ExpressionAttributeValues: {
          ':partition': key('USER', memberId),
          ':prefix': 'NOTIFICATION#',
        },
        ...(unreadOnly ? { IndexName: 'gsi2' } : {}),
        KeyConditionExpression: unreadOnly
          ? 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)'
          : 'pk = :partition AND begins_with(sk, :prefix)',
        Limit: limit,
        ScanIndexForward: false,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<Notification>(item as Item))
      .filter((item): item is Notification => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  public async updateNotificationReadState(
    memberId: string,
    notificationId: string,
    read: boolean,
  ): Promise<Notification> {
    try {
      const result = await this.documentClient.send(
        new UpdateCommand({
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: read
            ? { ':readAt': now() }
            : {
                ':gsi2pk': key('USER', memberId),
                ':gsi2sk': key('NOTIFICATION', notificationId),
              },
          Key: notificationKey(memberId, notificationId),
          ReturnValues: 'ALL_NEW',
          TableName: this.tableName,
          UpdateExpression: read
            ? 'SET readAt = :readAt REMOVE gsi2pk, gsi2sk'
            : 'SET gsi2pk = :gsi2pk, gsi2sk = :gsi2sk REMOVE readAt',
        }),
      );
      return withoutStorageKeys<Notification>(result.Attributes as Item) as Notification;
    } catch (error) {
      if (isConditionalFailure(error)) throw notFound('Notification');
      throw error;
    }
  }

  public async createProject(actor: Member, input: CreateProjectInput): Promise<Project> {
    const timestamp = now();
    const status = input.submitForReview ? 'pending_review' : 'draft';
    const project: Project = withOptional({
      createdAt: timestamp,
      description: input.description,
      id: randomUUID(),
      memberHandles: [actor.handle],
      memberIds: [actor.id],
      name: input.name,
      ownerId: actor.id,
      status,
      techStack: input.techStack,
      updatedAt: timestamp,
      ...(input.demoUrl ? { demoUrl: input.demoUrl } : {}),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    });

    await this.documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              ConditionExpression: 'attribute_not_exists(pk)',
              Item: this.projectItem(project),
              TableName: this.tableName,
            },
          },
          {
            Put: {
              Item: {
                createdAt: timestamp,
                entityType: 'ProjectMembership',
                ...membershipIndex(actor.id, 'project', project.id),
                initiatedById: actor.id,
                memberHandle: actor.handle,
                memberId: actor.id,
                pk: key('PROJECT', project.id),
                resourceId: project.id,
                resourceType: 'project',
                role: 'owner',
                sk: key('MEMBER', actor.id),
                status: 'active',
                updatedAt: timestamp,
              },
              TableName: this.tableName,
            },
          },
        ],
      }),
    );
    return project;
  }

  public async getProject(projectId: string): Promise<Project | undefined> {
    return this.getEntity<Project>('PROJECT', projectId);
  }

  public async listProjects(limit: number, cursor?: string): Promise<Page<Project>> {
    return this.listEntities<Project>('PROJECTS#PUBLISHED', limit, cursor);
  }

  public async listManagedProjects(
    status: PublicationStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Project>> {
    return this.listSecondaryEntities<Project>('RESOURCES#PROJECTS', limit, cursor, status);
  }

  public async updateProject(project: Project, patch: UpdateProjectInput): Promise<Project> {
    const status = patch.status ?? project.status;
    return this.updateAndReturn<Project>(entityKey('PROJECT', project.id), {
      ...patch,
      gsi1pk: status === 'published' ? 'PROJECTS#PUBLISHED' : null,
      gsi1sk: status === 'published' ? `CREATED#${project.createdAt}#${project.id}` : null,
      updatedAt: now(),
    });
  }

  public async archiveProject(project: Project): Promise<void> {
    await this.updateProject(project, { status: 'archived' });
  }

  public async requestProjectMembership(
    project: Project,
    member: Member,
  ): Promise<'requested' | 'already-member' | 'already-requested'> {
    if (project.status === 'archived') throw conflict('This project is archived.');
    const membershipKey = { pk: key('PROJECT', project.id), sk: key('MEMBER', member.id) };
    const existing = await this.getRaw(membershipKey);
    if (existing?.status === 'active') return 'already-member';
    if (existing?.status === 'requested') return 'already-requested';
    if (existing?.status === 'invited') {
      throw conflict('You already have an invitation; accept or decline it instead.');
    }
    if (existing?.status === 'rejected' || existing?.status === 'removed') {
      await this.restoreMembershipRequest('project', project, membershipKey, member);
      return 'requested';
    }

    const timestamp = now();
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...membershipKey,
                  createdAt: timestamp,
                  entityType: 'ProjectMembership',
                  ...membershipIndex(member.id, 'project', project.id),
                  initiatedById: member.id,
                  memberHandle: member.handle,
                  memberId: member.id,
                  resourceId: project.id,
                  resourceType: 'project',
                  role: 'contributor',
                  status: 'requested',
                  updatedAt: timestamp,
                },
                TableName: this.tableName,
              },
            },
            { Put: auditPut(this.tableName, 'project', project.id, 'requested', member.id, member.id, timestamp) },
            {
              Put: joinNotificationPut(
                this.tableName,
                project.ownerId,
                'requested',
                member,
                'project',
                project,
                timestamp,
              ),
            },
          ],
        }),
      );
      return 'requested';
    } catch (error) {
      if (isConditionalFailure(error)) return 'already-requested';
      throw error;
    }
  }

  public async reviewProjectMembership(
    project: Project,
    actor: Member,
    memberId: string,
    status: Exclude<JoinRequestStatus, 'requested'>,
  ): Promise<Project> {
    const member = await this.getMember(memberId);
    if (!member) throw notFound('Member');
    if (status === 'active' && member.status !== 'active') {
      throw conflict('A suspended member cannot be admitted.');
    }
    await this.reviewMembership('project', project, actor, member, status, false);
    return (await this.getProject(project.id)) as Project;
  }

  public async createTeam(actor: Member, input: CreateTeamInput): Promise<Team> {
    const timestamp = now();
    const team: Team = withOptional({
      category: input.category,
      createdAt: timestamp,
      description: input.description,
      id: randomUUID(),
      joinPolicy: input.joinPolicy,
      maxMembers: input.maxMembers,
      memberCount: 1,
      memberHandles: [actor.handle],
      memberIds: [actor.id],
      name: input.name,
      ownerId: actor.id,
      status: 'open',
      updatedAt: timestamp,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    });

    await this.documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              ConditionExpression: 'attribute_not_exists(pk)',
              Item: this.teamItem(team),
              TableName: this.tableName,
            },
          },
          {
            Put: {
              Item: {
                createdAt: timestamp,
                entityType: 'TeamMembership',
                ...membershipIndex(actor.id, 'team', team.id),
                initiatedById: actor.id,
                memberHandle: actor.handle,
                memberId: actor.id,
                pk: key('TEAM', team.id),
                resourceId: team.id,
                resourceType: 'team',
                role: 'owner',
                sk: key('MEMBER', actor.id),
                status: 'active',
                updatedAt: timestamp,
              },
              TableName: this.tableName,
            },
          },
        ],
      }),
    );
    return team;
  }

  public async getTeam(teamId: string): Promise<Team | undefined> {
    return this.getEntity<Team>('TEAM', teamId);
  }

  public async listTeams(limit: number, cursor?: string): Promise<Page<Team>> {
    return this.listEntities<Team>('TEAMS#ACTIVE', limit, cursor);
  }

  public async listManagedTeams(
    status: TeamStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Team>> {
    return this.listSecondaryEntities<Team>('RESOURCES#TEAMS', limit, cursor, status);
  }

  public async updateTeam(team: Team, patch: UpdateTeamInput): Promise<Team> {
    const status = patch.status ?? team.status;
    return this.updateAndReturn<Team>(entityKey('TEAM', team.id), {
      ...patch,
      gsi1pk: status === 'archived' ? null : 'TEAMS#ACTIVE',
      gsi1sk: status === 'archived' ? null : `CREATED#${team.createdAt}#${team.id}`,
      updatedAt: now(),
    });
  }

  public async archiveTeam(team: Team): Promise<void> {
    await this.updateTeam(team, { status: 'archived' });
  }

  public async requestTeamMembership(
    team: Team,
    member: Member,
  ): Promise<'joined' | 'requested' | 'already-member' | 'already-requested'> {
    if (team.status !== 'open') throw conflict('This team is not accepting members.');
    const membershipKey = { pk: key('TEAM', team.id), sk: key('MEMBER', member.id) };
    const existing = await this.getRaw(membershipKey);
    if (existing?.status === 'active') return 'already-member';
    if (existing?.status === 'requested') return 'already-requested';
    if (existing?.status === 'invited') {
      throw conflict('You already have an invitation; accept or decline it instead.');
    }

    if (team.joinPolicy === 'approval_required') {
      if (existing?.status === 'rejected' || existing?.status === 'removed') {
        await this.restoreMembershipRequest('team', team, membershipKey, member);
        return 'requested';
      }
      const timestamp = now();
      try {
        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  ConditionExpression: 'attribute_not_exists(pk)',
                  Item: {
                    ...membershipKey,
                    createdAt: timestamp,
                    entityType: 'TeamMembership',
                    ...membershipIndex(member.id, 'team', team.id),
                    initiatedById: member.id,
                    memberHandle: member.handle,
                    memberId: member.id,
                    resourceId: team.id,
                    resourceType: 'team',
                    role: 'member',
                    status: 'requested',
                    updatedAt: timestamp,
                  },
                  TableName: this.tableName,
                },
              },
              { Put: auditPut(this.tableName, 'team', team.id, 'requested', member.id, member.id, timestamp) },
              {
                Put: joinNotificationPut(
                  this.tableName,
                  team.ownerId,
                  'requested',
                  member,
                  'team',
                  team,
                  timestamp,
                ),
              },
            ],
          }),
        );
        return 'requested';
      } catch (error) {
        if (isConditionalFailure(error)) return 'already-requested';
        throw error;
      }
    }

    await this.addTeamMember(
      team,
      member,
      existing?.status === 'rejected' || existing?.status === 'removed',
    );
    return 'joined';
  }

  public async reviewTeamMembership(
    team: Team,
    actor: Member,
    memberId: string,
    status: Exclude<JoinRequestStatus, 'requested'>,
  ): Promise<Team> {
    const member = await this.getMember(memberId);
    if (!member) throw notFound('Member');
    if (status === 'active' && member.status !== 'active') {
      throw conflict('A suspended member cannot be admitted.');
    }
    await this.reviewMembership('team', team, actor, member, status, true);
    return (await this.getTeam(team.id)) as Team;
  }

  public async listResourceMemberships(
    resourceType: ResourceType,
    resourceId: string,
    status: MembershipStatus,
    limit: number,
    cursor?: string,
  ): Promise<Page<ResourceMembership>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':partition': key(resourceKind(resourceType), resourceId),
          ':prefix': 'MEMBER#',
          ':status': status,
        },
        FilterExpression: '#status = :status',
        KeyConditionExpression: 'pk = :partition AND begins_with(sk, :prefix)',
        Limit: limit,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<ResourceMembership>(item as Item))
      .filter((item): item is ResourceMembership => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  public async inviteResourceMember(
    resourceType: ResourceType,
    resource: ManagedResource,
    actor: Member,
    target: Member,
  ): Promise<void> {
    if (target.status !== 'active') throw conflict('Only active members can be invited.');
    if (target.id === actor.id) throw conflict('You cannot invite yourself.');
    if (resource.status === 'archived') throw conflict('Archived resources cannot invite members.');
    if (resourceType === 'team' && 'memberCount' in resource && resource.memberCount >= resource.maxMembers) {
      throw conflict('This team is full.');
    }

    const relationshipKey = membershipKey(resourceType, resource.id, target.id);
    const existing = await this.getRaw(relationshipKey);
    if (existing?.status === 'active') throw conflict('This member already belongs to the resource.');
    if (existing?.status === 'invited') throw conflict('This member already has a pending invitation.');
    if (existing?.status === 'requested') {
      throw conflict('This member already requested to join; review that request instead.');
    }

    const timestamp = now();
    const role = resourceType === 'project' ? 'contributor' : 'member';
    const membershipWrite =
      existing?.status === 'rejected' || existing?.status === 'removed'
        ? {
            Update: {
              ConditionExpression: '#status IN (:rejected, :removed)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':initiatedById': actor.id,
                ':invited': 'invited',
                ':memberHandle': target.handle,
                ':rejected': 'rejected',
                ':removed': 'removed',
                ':updatedAt': timestamp,
              },
              Key: relationshipKey,
              TableName: this.tableName,
              UpdateExpression:
                'SET #status = :invited, initiatedById = :initiatedById, memberHandle = :memberHandle, updatedAt = :updatedAt',
            },
          }
        : {
            Put: {
              ConditionExpression: 'attribute_not_exists(pk)',
              Item: {
                ...relationshipKey,
                createdAt: timestamp,
                entityType: `${resourceKind(resourceType)}Membership`,
                ...membershipIndex(target.id, resourceType, resource.id),
                initiatedById: actor.id,
                memberHandle: target.handle,
                memberId: target.id,
                resourceId: resource.id,
                resourceType,
                role,
                status: 'invited',
                updatedAt: timestamp,
              },
              TableName: this.tableName,
            },
          };

    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            membershipWrite,
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...invitationKey(target.id, resourceType, resource.id),
                  createdAt: timestamp,
                  entityType: 'MembershipInvitation',
                  invitedByHandle: actor.handle,
                  invitedById: actor.id,
                  resourceId: resource.id,
                  resourceName: resource.name,
                  resourceType,
                },
                TableName: this.tableName,
              },
            },
            {
              Put: auditPut(
                this.tableName,
                resourceType,
                resource.id,
                'invited',
                actor.id,
                target.id,
                timestamp,
              ),
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The membership or invitation changed; retry.');
      throw error;
    }
  }

  public async addResourceMember(
    resourceType: ResourceType,
    resource: ManagedResource,
    actor: Member,
    target: Member,
  ): Promise<ManagedResource> {
    if (target.status !== 'active') throw conflict('Only active members can be added.');
    if (target.id === actor.id) throw conflict('You cannot add yourself.');
    if (resource.status === 'archived') throw conflict('Archived resources cannot add members.');
    if (
      resourceType === 'team' &&
      'memberCount' in resource &&
      resource.memberCount >= resource.maxMembers
    ) {
      throw conflict('This team is full.');
    }

    const relationshipKey = membershipKey(resourceType, resource.id, target.id);
    const existing = await this.getRaw(relationshipKey);
    if (existing?.status === 'active') throw conflict('This member already belongs to the resource.');
    const reusableStatuses = ['invited', 'requested', 'rejected', 'removed'];
    if (existing && !reusableStatuses.includes(String(existing.status))) {
      throw conflict('This membership cannot be activated in its current state.');
    }

    const timestamp = now();
    const role = resourceType === 'project' ? 'contributor' : 'member';
    const membershipWrite = existing
      ? {
          Update: {
            ConditionExpression: '#status IN (:invited, :requested, :rejected, :removed)',
            ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':initiatedById': actor.id,
              ':invited': 'invited',
              ':memberHandle': target.handle,
              ':rejected': 'rejected',
              ':removed': 'removed',
              ':requested': 'requested',
              ':role': role,
              ':updatedAt': timestamp,
            },
            Key: relationshipKey,
            TableName: this.tableName,
            UpdateExpression:
              'SET #status = :active, #role = :role, initiatedById = :initiatedById, memberHandle = :memberHandle, updatedAt = :updatedAt',
          },
        }
      : {
          Put: {
            ConditionExpression: 'attribute_not_exists(pk)',
            Item: {
              ...relationshipKey,
              createdAt: timestamp,
              entityType: `${resourceKind(resourceType)}Membership`,
              ...membershipIndex(target.id, resourceType, resource.id),
              initiatedById: actor.id,
              memberHandle: target.handle,
              memberId: target.id,
              resourceId: resource.id,
              resourceType,
              role,
              status: 'active',
              updatedAt: timestamp,
            },
            TableName: this.tableName,
          },
        };

    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      membershipWrite,
      {
        Delete: {
          Key: invitationKey(target.id, resourceType, resource.id),
          TableName: this.tableName,
        },
      },
      {
        Update: this.addMemberToResourceUpdate(resourceType, resource, target, timestamp),
      },
      {
        Put: auditPut(
          this.tableName,
          resourceType,
          resource.id,
          'added',
          actor.id,
          target.id,
          timestamp,
        ),
      },
    ];
    if (existing?.status === 'requested') {
      transactionItems.push({
        Put: joinNotificationPut(
          this.tableName,
          target.id,
          'approved',
          actor,
          resourceType,
          resource,
          timestamp,
        ),
      });
    }

    try {
      await this.documentClient.send(
        new TransactWriteCommand({ TransactItems: transactionItems }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('The membership changed, the resource was edited, or the team is full.');
      }
      throw error;
    }
    return this.requireManagedResource(resourceType, resource.id);
  }

  public async revokeResourceInvitation(
    resourceType: ResourceType,
    resourceId: string,
    actor: Member,
    targetMemberId: string,
  ): Promise<void> {
    const timestamp = now();
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ConditionExpression: '#status = :invited',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':invited': 'invited',
                  ':removed': 'removed',
                  ':updatedAt': timestamp,
                },
                Key: membershipKey(resourceType, resourceId, targetMemberId),
                TableName: this.tableName,
                UpdateExpression: 'SET #status = :removed, updatedAt = :updatedAt',
              },
            },
            {
              Delete: {
                Key: invitationKey(targetMemberId, resourceType, resourceId),
                TableName: this.tableName,
              },
            },
            {
              Put: auditPut(
                this.tableName,
                resourceType,
                resourceId,
                'invitation_revoked',
                actor.id,
                targetMemberId,
                timestamp,
              ),
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The invitation is no longer pending.');
      throw error;
    }
  }

  public async withdrawResourceRequest(
    resourceType: ResourceType,
    resource: ManagedResource,
    member: Member,
  ): Promise<void> {
    const timestamp = now();
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ConditionExpression: '#status = :requested',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':removed': 'removed',
                  ':requested': 'requested',
                  ':updatedAt': timestamp,
                },
                Key: membershipKey(resourceType, resource.id, member.id),
                TableName: this.tableName,
                UpdateExpression: 'SET #status = :removed, updatedAt = :updatedAt',
              },
            },
            {
              Put: auditPut(
                this.tableName,
                resourceType,
                resource.id,
                'request_withdrawn',
                member.id,
                member.id,
                timestamp,
              ),
            },
            {
              Put: joinNotificationPut(
                this.tableName,
                resource.ownerId,
                'withdrawn',
                member,
                resourceType,
                resource,
                timestamp,
              ),
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('There is no pending join request.');
      throw error;
    }
  }

  public async respondToResourceInvitation(
    resourceType: ResourceType,
    resource: ManagedResource,
    member: Member,
    response: 'accepted' | 'declined',
  ): Promise<ManagedResource> {
    const relationshipKey = membershipKey(resourceType, resource.id, member.id);
    const relationship = await this.getRaw(relationshipKey);
    if (relationship?.status !== 'invited') throw conflict('There is no pending invitation.');

    const timestamp = now();
    const accepted = response === 'accepted';
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          ConditionExpression: '#status = :invited',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':invited': 'invited',
            ':next': accepted ? 'active' : 'rejected',
            ':updatedAt': timestamp,
          },
          Key: relationshipKey,
          TableName: this.tableName,
          UpdateExpression: 'SET #status = :next, updatedAt = :updatedAt',
        },
      },
      {
        Delete: {
          Key: invitationKey(member.id, resourceType, resource.id),
          TableName: this.tableName,
        },
      },
      {
        Put: auditPut(
          this.tableName,
          resourceType,
          resource.id,
          accepted ? 'accepted' : 'declined',
          member.id,
          member.id,
          timestamp,
        ),
      },
    ];

    if (accepted) {
      transactionItems.push({
        Update: this.addMemberToResourceUpdate(resourceType, resource, member, timestamp),
      });
    }

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('The invitation changed, the resource was edited, or the team is full.');
      }
      throw error;
    }
    return this.requireManagedResource(resourceType, resource.id);
  }

  public async removeResourceMember(
    resourceType: ResourceType,
    resource: ManagedResource,
    actor: Member,
    targetMemberId: string,
    action: 'removed' | 'left',
  ): Promise<ManagedResource> {
    if (targetMemberId === resource.ownerId) {
      throw conflict('Transfer ownership before removing the current owner.');
    }
    const relationshipKey = membershipKey(resourceType, resource.id, targetMemberId);
    const relationship = await this.getRaw(relationshipKey);
    if (relationship?.status !== 'active' || typeof relationship.memberHandle !== 'string') {
      throw conflict('This member is not active on the resource.');
    }

    const timestamp = now();
    const nextMemberIds = resource.memberIds.filter((id) => id !== targetMemberId);
    const nextMemberHandles = resource.memberHandles.filter(
      (handle) => handle !== relationship.memberHandle,
    );
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':removed': 'removed',
            ':updatedAt': timestamp,
          },
          Key: relationshipKey,
          TableName: this.tableName,
          UpdateExpression: 'SET #status = :removed, updatedAt = :updatedAt',
        },
      },
      {
        Update: this.replaceResourceMembersUpdate(
          resourceType,
          resource,
          nextMemberIds,
          nextMemberHandles,
          timestamp,
        ),
      },
      {
        Put: auditPut(
          this.tableName,
          resourceType,
          resource.id,
          action,
          actor.id,
          targetMemberId,
          timestamp,
        ),
      },
    ];

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }));
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The membership or resource changed; retry.');
      throw error;
    }
    return this.requireManagedResource(resourceType, resource.id);
  }

  public async transferResourceOwnership(
    resourceType: ResourceType,
    resource: ManagedResource,
    actor: Member,
    target: Member,
  ): Promise<ManagedResource> {
    if (target.id === resource.ownerId) throw conflict('This member already owns the resource.');
    if (target.status !== 'active') throw conflict('Ownership requires an active club account.');
    const targetRelationshipKey = membershipKey(resourceType, resource.id, target.id);
    const targetRelationship = await this.getRaw(targetRelationshipKey);
    if (targetRelationship?.status !== 'active') {
      throw conflict('Ownership can only be transferred to an active member.');
    }

    const timestamp = now();
    const previousOwnerRole = resourceType === 'project' ? 'contributor' : 'member';
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          ConditionExpression: 'ownerId = :currentOwner AND updatedAt = :expectedUpdatedAt',
          ExpressionAttributeValues: {
            ':currentOwner': resource.ownerId,
            ':expectedUpdatedAt': resource.updatedAt,
            ':nextOwner': target.id,
            ':updatedAt': timestamp,
          },
          Key: entityKey(resourceKind(resourceType), resource.id),
          TableName: this.tableName,
          UpdateExpression: 'SET ownerId = :nextOwner, updatedAt = :updatedAt',
        },
      },
      {
        Update: {
          ConditionExpression: '#role = :owner AND #status = :active',
          ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':nextRole': previousOwnerRole,
            ':owner': 'owner',
            ':updatedAt': timestamp,
          },
          Key: membershipKey(resourceType, resource.id, resource.ownerId),
          TableName: this.tableName,
          UpdateExpression: 'SET #role = :nextRole, updatedAt = :updatedAt',
        },
      },
      {
        Update: {
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': 'active',
            ':owner': 'owner',
            ':updatedAt': timestamp,
          },
          Key: targetRelationshipKey,
          TableName: this.tableName,
          UpdateExpression: 'SET #role = :owner, updatedAt = :updatedAt',
        },
      },
      {
        Put: auditPut(
          this.tableName,
          resourceType,
          resource.id,
          'ownership_transferred',
          actor.id,
          target.id,
          timestamp,
        ),
      },
    ];

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }));
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The ownership or membership changed; retry.');
      throw error;
    }
    return this.requireManagedResource(resourceType, resource.id);
  }

  public async listMemberInvitations(
    memberId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<MembershipInvitation>> {
    return this.listPartitionItems<MembershipInvitation>(
      key('USER', memberId),
      'INVITE#',
      limit,
      cursor,
    );
  }

  public async listMemberResourceMemberships(
    memberId: string,
    resourceType: ResourceType | undefined,
    status: MembershipStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<ResourceMembership>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ...(status
          ? {
              ExpressionAttributeNames: { '#status': 'status' },
              FilterExpression: '#status = :status',
            }
          : {}),
        ExpressionAttributeValues: {
          ':partition': key('USER', memberId),
          ':prefix': resourceType
            ? `RESOURCE#${resourceType.toUpperCase()}#`
            : 'RESOURCE#',
          ...(status ? { ':status': status } : {}),
        },
        IndexName: 'gsi2',
        KeyConditionExpression: 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)',
        Limit: limit,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<ResourceMembership>(item as Item))
      .filter((item): item is ResourceMembership => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  public async listMembershipAudit(
    resourceType: ResourceType,
    resourceId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<MembershipAuditEntry>> {
    return this.listPartitionItems<MembershipAuditEntry>(
      key(resourceKind(resourceType), resourceId),
      'AUDIT#',
      limit,
      cursor,
      false,
    );
  }

  public async createEvent(actor: Member, input: CreateEventInput): Promise<ClubEvent> {
    const timestamp = now();
    const event: ClubEvent = withOptional({
      createdAt: timestamp,
      createdBy: actor.id,
      description: input.description,
      endsAt: input.endsAt,
      id: randomUUID(),
      location: input.location,
      name: input.name,
      published: input.published,
      startsAt: input.startsAt,
      updatedAt: timestamp,
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    });
    await this.documentClient.send(
      new PutCommand({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: this.eventItem(event),
        TableName: this.tableName,
      }),
    );
    return event;
  }

  public async getEvent(eventId: string): Promise<ClubEvent | undefined> {
    return this.getEntity<ClubEvent>('EVENT', eventId);
  }

  public async listEvents(limit: number, cursor?: string): Promise<Page<ClubEvent>> {
    return this.listEntities<ClubEvent>('EVENTS#PUBLISHED', limit, cursor, true);
  }

  public async listManagedEvents(limit: number, cursor?: string): Promise<Page<ClubEvent>> {
    return this.listSecondaryEntities<ClubEvent>('RESOURCES#EVENTS', limit, cursor, undefined, true);
  }

  public async updateEvent(event: ClubEvent, patch: UpdateEventInput): Promise<ClubEvent> {
    const published = patch.published ?? event.published;
    return this.updateAndReturn<ClubEvent>(entityKey('EVENT', event.id), {
      ...patch,
      gsi1pk: published ? 'EVENTS#PUBLISHED' : null,
      gsi1sk: published ? `START#${patch.startsAt ?? event.startsAt}#${event.id}` : null,
      gsi2sk: `START#${patch.startsAt ?? event.startsAt}#${event.id}`,
      updatedAt: now(),
    });
  }

  public async archiveEvent(event: ClubEvent): Promise<void> {
    await this.updateAndReturn<ClubEvent>(entityKey('EVENT', event.id), {
      archived: true,
      gsi1pk: null,
      gsi1sk: null,
      published: false,
      updatedAt: now(),
    });
  }

  public async setEventRsvp(
    event: ClubEvent,
    member: Member,
    status: 'going' | 'maybe',
  ): Promise<void> {
    await this.documentClient.send(
      new PutCommand({
        Item: {
          entityType: 'EventRsvp',
          memberHandle: member.handle,
          memberId: member.id,
          pk: key('EVENT', event.id),
          sk: key('MEMBER', member.id),
          status,
          updatedAt: now(),
        },
        TableName: this.tableName,
      }),
    );
  }

  public async removeEventRsvp(event: ClubEvent, member: Member): Promise<void> {
    await this.documentClient.send(
      new DeleteCommand({
        Key: { pk: key('EVENT', event.id), sk: key('MEMBER', member.id) },
        TableName: this.tableName,
      }),
    );
  }

  public async listEventRsvps(
    eventId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<EventRsvp>> {
    return this.listPartitionItems<EventRsvp>(key('EVENT', eventId), 'MEMBER#', limit, cursor);
  }

  public async createNewsletter(
    actor: Member,
    input: CreateNewsletterInput,
  ): Promise<Newsletter> {
    const timestamp = now();
    const newsletter: Newsletter = {
      body: input.body,
      createdAt: timestamp,
      createdBy: actor.id,
      createdByHandle: actor.handle,
      fanoutComplete: false,
      id: input.idempotencyKey,
      processedCount: 0,
      recipientCount: 0,
      sentCount: 0,
      skippedCount: 0,
      status: 'queued',
      subject: input.subject,
      updatedAt: timestamp,
    };

    try {
      await this.documentClient.send(
        new PutCommand({
          ConditionExpression: 'attribute_not_exists(pk)',
          Item: {
            ...entityKey('NEWSLETTER', newsletter.id),
            ...newsletter,
            entityType: 'Newsletter',
            gsi2pk: 'NEWSLETTERS',
            gsi2sk: `CREATED#${newsletter.createdAt}#${newsletter.id}`,
          },
          TableName: this.tableName,
        }),
      );
      return newsletter;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const existing = await this.getNewsletter(newsletter.id);
      if (
        existing?.createdBy === actor.id &&
        existing.subject === input.subject &&
        existing.body === input.body
      ) {
        return existing;
      }
      throw conflict('This newsletter idempotency key is already used by another request.');
    }
  }

  public async getNewsletter(newsletterId: string): Promise<Newsletter | undefined> {
    return this.getEntity<Newsletter>('NEWSLETTER', newsletterId);
  }

  public async listNewsletters(limit: number, cursor?: string): Promise<Page<Newsletter>> {
    return this.listSecondaryEntities<Newsletter>('NEWSLETTERS', limit, cursor);
  }

  public async updateNewsletterStatus(
    newsletterId: string,
    expectedStatus: NewsletterStatus,
    status: NewsletterStatus,
  ): Promise<Newsletter> {
    try {
      const result = await this.documentClient.send(
        new UpdateCommand({
          ConditionExpression: '#status = :expectedStatus',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expectedStatus': expectedStatus,
            ':status': status,
            ':updatedAt': now(),
          },
          Key: entityKey('NEWSLETTER', newsletterId),
          ReturnValues: 'ALL_NEW',
          TableName: this.tableName,
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        }),
      );
      return withoutStorageKeys<Newsletter>(result.Attributes as Item) as Newsletter;
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The newsletter status changed; retry.');
      throw error;
    }
  }

  public async markNewsletterFanout(
    newsletterId: string,
    recipientCount: number,
  ): Promise<Newsletter> {
    const result = await this.documentClient.send(
      new UpdateCommand({
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':fanoutComplete': true,
          ':recipientCount': recipientCount,
          ':status': recipientCount === 0 ? 'sent' : 'sending',
          ':updatedAt': now(),
        },
        Key: entityKey('NEWSLETTER', newsletterId),
        ReturnValues: 'ALL_NEW',
        TableName: this.tableName,
        UpdateExpression:
          'SET #status = :status, fanoutComplete = :fanoutComplete, recipientCount = :recipientCount, updatedAt = :updatedAt',
      }),
    );
    return withoutStorageKeys<Newsletter>(result.Attributes as Item) as Newsletter;
  }

  public async hasNewsletterDelivery(newsletterId: string, memberId: string): Promise<boolean> {
    const result = await this.documentClient.send(
      new GetCommand({
        Key: newsletterDeliveryKey(newsletterId, memberId),
        ProjectionExpression: 'pk',
        TableName: this.tableName,
      }),
    );
    return result.Item !== undefined;
  }

  public async recordNewsletterDelivery(
    newsletterId: string,
    memberId: string,
    outcome: 'sent' | 'skipped',
  ): Promise<Newsletter> {
    const timestamp = now();
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  ...newsletterDeliveryKey(newsletterId, memberId),
                  acceptedAt: timestamp,
                  entityType: 'NewsletterDelivery',
                  memberId,
                  outcome,
                },
                TableName: this.tableName,
              },
            },
            {
              Update: {
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':sentIncrement': outcome === 'sent' ? 1 : 0,
                  ':skippedIncrement': outcome === 'skipped' ? 1 : 0,
                  ':updatedAt': timestamp,
                },
                Key: entityKey('NEWSLETTER', newsletterId),
                TableName: this.tableName,
                UpdateExpression:
                  'SET updatedAt = :updatedAt ADD processedCount :one, sentCount :sentIncrement, skippedCount :skippedIncrement',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    const newsletter = await this.getNewsletter(newsletterId);
    if (!newsletter) throw notFound('Newsletter');
    return newsletter;
  }

  public async listNewsletterRecipients(
    limit: number,
    cursor?: string,
  ): Promise<Page<Member>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':partition': 'MEMBERS',
        },
        FilterExpression: '#status = :active',
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :partition',
        Limit: limit,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<Member>(item as Item))
      .filter((item): item is Member => item !== undefined)
      .map(normalizeMember);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  private async getEntity<T>(kind: EntityKind, id: string): Promise<T | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({ Key: entityKey(kind, id), TableName: this.tableName }),
    );
    return withoutStorageKeys<T>(result.Item as Item | undefined);
  }

  private async getRaw(itemKey: Record<'pk' | 'sk', string>): Promise<Item | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({ Key: itemKey, TableName: this.tableName }),
    );
    return result.Item as Item | undefined;
  }

  private async listEntities<T>(
    partition: string,
    limit: number,
    cursor?: string,
    ascending = false,
  ): Promise<Page<T>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeValues: { ':partition': partition },
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :partition',
        Limit: limit,
        ScanIndexForward: ascending,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<T>(item as Item))
      .filter((item): item is T => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  private async listSecondaryEntities<T>(
    partition: string,
    limit: number,
    cursor?: string,
    status?: PublicationStatus | TeamStatus,
    ascending = false,
  ): Promise<Page<T>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ...(status
          ? {
              ExpressionAttributeNames: { '#status': 'status' },
              FilterExpression: '#status = :status',
            }
          : {}),
        ExpressionAttributeValues: {
          ':partition': partition,
          ...(status ? { ':status': status } : {}),
        },
        IndexName: 'gsi2',
        KeyConditionExpression: 'gsi2pk = :partition',
        Limit: limit,
        ScanIndexForward: ascending,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<T>(item as Item))
      .filter((item): item is T => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  private async listPartitionItems<T>(
    partition: string,
    sortPrefix: string,
    limit: number,
    cursor?: string,
    ascending = true,
  ): Promise<Page<T>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeValues: {
          ':partition': partition,
          ':prefix': sortPrefix,
        },
        KeyConditionExpression: 'pk = :partition AND begins_with(sk, :prefix)',
        Limit: limit,
        ScanIndexForward: ascending,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? [])
      .map((item) => withoutStorageKeys<T>(item as Item))
      .filter((item): item is T => item !== undefined);
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  private addMemberToResourceUpdate(
    resourceType: ResourceType,
    resource: ManagedResource,
    member: Member,
    timestamp: string,
  ): TransactionUpdate {
    const isTeam = resourceType === 'team';
    return {
      ConditionExpression: isTeam
        ? '#status <> :archived AND memberCount < maxMembers AND updatedAt = :expectedUpdatedAt'
        : '#status <> :archived AND updatedAt = :expectedUpdatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':archived': 'archived',
        ':expectedUpdatedAt': resource.updatedAt,
        ':memberHandles': [member.handle],
        ':memberIds': [member.id],
        ':updatedAt': timestamp,
        ...(isTeam ? { ':one': 1 } : {}),
      },
      Key: entityKey(resourceKind(resourceType), resource.id),
      TableName: this.tableName,
      UpdateExpression: isTeam
        ? 'SET memberIds = list_append(memberIds, :memberIds), memberHandles = list_append(memberHandles, :memberHandles), updatedAt = :updatedAt ADD memberCount :one'
        : 'SET memberIds = list_append(memberIds, :memberIds), memberHandles = list_append(memberHandles, :memberHandles), updatedAt = :updatedAt',
    };
  }

  private replaceResourceMembersUpdate(
    resourceType: ResourceType,
    resource: ManagedResource,
    memberIds: string[],
    memberHandles: string[],
    timestamp: string,
  ): TransactionUpdate {
    const isTeam = resourceType === 'team';
    return {
      ConditionExpression: 'updatedAt = :expectedUpdatedAt',
      ExpressionAttributeValues: {
        ':expectedUpdatedAt': resource.updatedAt,
        ':memberHandles': memberHandles,
        ':memberIds': memberIds,
        ':updatedAt': timestamp,
        ...(isTeam ? { ':memberCount': memberIds.length } : {}),
      },
      Key: entityKey(resourceKind(resourceType), resource.id),
      TableName: this.tableName,
      UpdateExpression: isTeam
        ? 'SET memberIds = :memberIds, memberHandles = :memberHandles, memberCount = :memberCount, updatedAt = :updatedAt'
        : 'SET memberIds = :memberIds, memberHandles = :memberHandles, updatedAt = :updatedAt',
    };
  }

  private async requireManagedResource(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<ManagedResource> {
    const resource =
      resourceType === 'project'
        ? await this.getProject(resourceId)
        : await this.getTeam(resourceId);
    if (!resource) throw notFound(resourceType === 'project' ? 'Project' : 'Team');
    return resource;
  }

  private async updateAndReturn<T>(
    itemKey: Record<'pk' | 'sk', string>,
    patch: Record<string, unknown>,
  ): Promise<T> {
    const update = buildUpdate(patch);
    const result = await this.documentClient.send(
      new UpdateCommand({
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: update.values,
        Key: itemKey,
        ReturnValues: 'ALL_NEW',
        TableName: this.tableName,
        UpdateExpression: update.expression,
      }),
    );
    return withoutStorageKeys<T>(result.Attributes as Item) as T;
  }

  private projectItem(project: Project): Item {
    return {
      ...entityKey('PROJECT', project.id),
      ...project,
      entityType: 'Project',
      gsi2pk: 'RESOURCES#PROJECTS',
      gsi2sk: `CREATED#${project.createdAt}#${project.id}`,
      ...(project.status === 'published'
        ? { gsi1pk: 'PROJECTS#PUBLISHED', gsi1sk: `CREATED#${project.createdAt}#${project.id}` }
        : {}),
    };
  }

  private teamItem(team: Team): Item {
    return {
      ...entityKey('TEAM', team.id),
      ...team,
      entityType: 'Team',
      gsi1pk: 'TEAMS#ACTIVE',
      gsi1sk: `CREATED#${team.createdAt}#${team.id}`,
      gsi2pk: 'RESOURCES#TEAMS',
      gsi2sk: `CREATED#${team.createdAt}#${team.id}`,
    };
  }

  private eventItem(event: ClubEvent): Item {
    return {
      ...entityKey('EVENT', event.id),
      ...event,
      entityType: 'Event',
      gsi2pk: 'RESOURCES#EVENTS',
      gsi2sk: `START#${event.startsAt}#${event.id}`,
      ...(event.published
        ? { gsi1pk: 'EVENTS#PUBLISHED', gsi1sk: `START#${event.startsAt}#${event.id}` }
        : {}),
    };
  }

  private async reviewMembership(
    resourceType: ResourceType,
    resource: ManagedResource,
    actor: Member,
    member: Member,
    status: Exclude<JoinRequestStatus, 'requested'>,
    incrementCount: boolean,
  ): Promise<void> {
    const relationshipKey = membershipKey(resourceType, resource.id, member.id);
    const timestamp = now();
    const membershipUpdate = {
      ConditionExpression: '#status = :requested',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':next': status, ':requested': 'requested', ':updatedAt': timestamp },
      Key: relationshipKey,
      TableName: this.tableName,
      UpdateExpression: 'SET #status = :next, updatedAt = :updatedAt',
    };

    const transactionItems: ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems'] = [
      { Update: membershipUpdate },
    ];

    if (status === 'active') {
      transactionItems?.push({
        Update: {
          ...(incrementCount
            ? {
                ConditionExpression: '#status <> :archived AND memberCount < maxMembers',
                UpdateExpression:
                  'SET memberIds = list_append(memberIds, :memberIds), memberHandles = list_append(memberHandles, :memberHandles), updatedAt = :updatedAt ADD memberCount :one',
              }
            : {
                ConditionExpression: '#status <> :archived',
                UpdateExpression:
                  'SET memberIds = list_append(memberIds, :memberIds), memberHandles = list_append(memberHandles, :memberHandles), updatedAt = :updatedAt',
              }),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':archived': 'archived',
            ':memberHandles': [member.handle],
            ':memberIds': [member.id],
            ':updatedAt': timestamp,
            ...(incrementCount ? { ':one': 1 } : {}),
          },
          Key: entityKey(resourceKind(resourceType), resource.id),
          TableName: this.tableName,
        },
      });
    }

    transactionItems?.push({
      Put: auditPut(
        this.tableName,
        resourceType,
        resource.id,
        status === 'active' ? 'accepted' : 'rejected',
        actor.id,
        member.id,
        timestamp,
      ),
    });
    transactionItems?.push({
      Put: joinNotificationPut(
        this.tableName,
        member.id,
        status === 'active' ? 'approved' : 'rejected',
        actor,
        resourceType,
        resource,
        timestamp,
      ),
    });

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('The join request is no longer pending, or the team is full.');
      }
      throw error;
    }
  }

  private async restoreMembershipRequest(
    resourceType: ResourceType,
    resource: ManagedResource,
    relationshipKey: Record<'pk' | 'sk', string>,
    member: Member,
  ): Promise<void> {
    const timestamp = now();
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ConditionExpression: '#status IN (:rejected, :removed)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':memberHandle': member.handle,
                  ':memberId': member.id,
                  ':rejected': 'rejected',
                  ':removed': 'removed',
                  ':requested': 'requested',
                  ':updatedAt': timestamp,
                },
                Key: relationshipKey,
                TableName: this.tableName,
                UpdateExpression:
                  'SET #status = :requested, initiatedById = :memberId, memberHandle = :memberHandle, updatedAt = :updatedAt',
              },
            },
            {
              Put: auditPut(
                this.tableName,
                resourceType,
                resource.id,
                'requested',
                member.id,
                member.id,
                timestamp,
              ),
            },
            {
              Put: joinNotificationPut(
                this.tableName,
                resource.ownerId,
                'requested',
                member,
                resourceType,
                resource,
                timestamp,
              ),
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The membership request changed; retry.');
      throw error;
    }
  }

  private async addTeamMember(
    team: Team,
    member: Member,
    restoreInactiveMembership: boolean,
  ): Promise<void> {
    const timestamp = now();
    const membershipKey = { pk: key('TEAM', team.id), sk: key('MEMBER', member.id) };
    const membershipWrite = restoreInactiveMembership
      ? {
          Update: {
            ConditionExpression: '#status IN (:rejected, :removed)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':memberHandle': member.handle,
              ':rejected': 'rejected',
              ':removed': 'removed',
              ':updatedAt': timestamp,
            },
            Key: membershipKey,
            TableName: this.tableName,
            UpdateExpression:
              'SET #status = :active, memberHandle = :memberHandle, updatedAt = :updatedAt',
          },
        }
      : {
          Put: {
            ConditionExpression: 'attribute_not_exists(pk)',
            Item: {
              ...membershipKey,
              createdAt: timestamp,
              entityType: 'TeamMembership',
              ...membershipIndex(member.id, 'team', team.id),
              initiatedById: member.id,
              memberHandle: member.handle,
              memberId: member.id,
              resourceId: team.id,
              resourceType: 'team',
              role: 'member',
              status: 'active',
              updatedAt: timestamp,
            },
            TableName: this.tableName,
          },
        };

    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            membershipWrite,
            {
              Update: {
                ConditionExpression: '#status = :open AND memberCount < maxMembers',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':memberHandles': [member.handle],
                  ':memberIds': [member.id],
                  ':one': 1,
                  ':open': 'open',
                  ':updatedAt': timestamp,
                },
                Key: entityKey('TEAM', team.id),
                TableName: this.tableName,
                UpdateExpression:
                  'SET memberIds = list_append(memberIds, :memberIds), memberHandles = list_append(memberHandles, :memberHandles), updatedAt = :updatedAt ADD memberCount :one',
              },
            },
            {
              Put: auditPut(
                this.tableName,
                'team',
                team.id,
                'accepted',
                member.id,
                member.id,
                timestamp,
              ),
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw conflict('The team is full or no longer open.');
      throw error;
    }
  }
}

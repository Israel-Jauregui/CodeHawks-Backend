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
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type {
  AuthenticatedIdentity,
  ClubEvent,
  ClubRole,
  EventRsvp,
  JoinRequestStatus,
  Member,
  MemberPreferenceAuditEntry,
  MemberPrivacyExport,
  MemberStatus,
  MembershipAuditEntry,
  MembershipInvitation,
  MembershipStatus,
  Newsletter,
  NewsletterDelivery,
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
import { CURRENT_PRIVACY_POLICY_VERSION } from '../domain/entities.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
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

const NEWSLETTER_DELIVERY_LEASE_MS = 5 * 60 * 1000;

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

function preferenceAuditPut(
  tableName: string,
  member: Member,
  patch: UpdateMemberProfileInput,
  timestamp: string,
): TransactionPut | undefined {
  const changes: MemberPreferenceAuditEntry['changes'] = {
    ...(patch.isPublicProfile !== undefined &&
    patch.isPublicProfile !== member.isPublicProfile
      ? {
          isPublicProfile: {
            from: member.isPublicProfile,
            to: patch.isPublicProfile,
          },
        }
      : {}),
    ...(patch.newsletterOptIn !== undefined &&
    patch.newsletterOptIn !== member.newsletterOptIn
      ? {
          newsletterOptIn: {
            from: member.newsletterOptIn,
            to: patch.newsletterOptIn,
          },
        }
      : {}),
  };
  if (Object.keys(changes).length === 0) return undefined;

  const audit: MemberPreferenceAuditEntry = {
    actorMemberId: member.id,
    changes,
    createdAt: timestamp,
    id: randomUUID(),
    memberId: member.id,
    policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    source: 'self_service_profile',
  };
  return {
    ConditionExpression: 'attribute_not_exists(pk)',
    Item: {
      ...audit,
      entityType: 'MemberPreferenceAudit',
      pk: key('USER', member.id),
      sk: `PREFERENCE_AUDIT#${timestamp}#${audit.id}`,
    },
    TableName: tableName,
  };
}

function preferenceConcurrencyCondition(member: Member): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, NativeAttributeValue>;
} {
  return {
    expression: [
      member.isPublicProfile
        ? '#currentPublic = :currentPublic'
        : '(attribute_not_exists(#currentPublic) OR #currentPublic = :currentPublic)',
      member.newsletterOptIn
        ? '#currentNewsletter = :currentNewsletter'
        : '(attribute_not_exists(#currentNewsletter) OR #currentNewsletter = :currentNewsletter)',
    ].join(' AND '),
    names: {
      '#currentNewsletter': 'newsletterOptIn',
      '#currentPublic': 'isPublicProfile',
    },
    values: {
      ':currentNewsletter': member.newsletterOptIn,
      ':currentPublic': member.isPublicProfile,
    },
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

function generatedMemberHandle(): string {
  return `member-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function normalizeMember(member: Member): Member {
  return {
    ...member,
    isPublicProfile: member.isPublicProfile ?? false,
    minors: member.minors ?? [],
    newsletterOptIn: member.newsletterOptIn ?? false,
    techStack: member.techStack ?? [],
  };
}

function publicDirectoryIndex(
  handle: string,
): Record<'gsi2pk' | 'gsi2sk', string> {
  return {
    gsi2pk: 'MEMBERS#PUBLIC',
    gsi2sk: `HANDLE#${handle}`,
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

function toNewsletterDelivery(item: Item): NewsletterDelivery {
  const reconciliationResolution: unknown = item.reconciliationResolution;
  const delivery: NewsletterDelivery = {
    memberId: String(item.memberId),
    outcome: item.outcome as NewsletterDelivery['outcome'],
    ...(typeof item.claimedAt === 'string' ? { claimedAt: item.claimedAt } : {}),
    ...(typeof item.leaseExpiresAt === 'string'
      ? { leaseExpiresAt: item.leaseExpiresAt }
      : {}),
    ...(typeof item.attemptStartedAt === 'string'
      ? { attemptStartedAt: item.attemptStartedAt }
      : {}),
    ...(typeof item.completedAt === 'string' ? { completedAt: item.completedAt } : {}),
    ...(typeof item.providerMessageId === 'string'
      ? { providerMessageId: item.providerMessageId }
      : {}),
    ...(typeof item.reconciledAt === 'string'
      ? { reconciledAt: item.reconciledAt }
      : {}),
    ...(typeof item.reconciledBy === 'string'
      ? { reconciledBy: item.reconciledBy }
      : {}),
    ...(reconciliationResolution === 'mark_sent' ||
    reconciliationResolution === 'mark_skipped' ||
    reconciliationResolution === 'retry'
      ? { reconciliationResolution }
      : {}),
    ...(typeof item.reconciliationReason === 'string'
      ? { reconciliationReason: item.reconciliationReason }
      : {}),
    ...(typeof item.duplicateRiskAcknowledged === 'boolean'
      ? { duplicateRiskAcknowledged: item.duplicateRiskAcknowledged }
      : {}),
  };
  return delivery;
}

function storageKey(item: Item): Record<'pk' | 'sk', string> {
  const pk: unknown = item.pk;
  const sk: unknown = item.sk;
  if (typeof pk !== 'string' || typeof sk !== 'string') {
    throw new Error('A stored item is missing its primary key.');
  }
  return { pk, sk };
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
    if (identityLookup?.suspended === true) {
      throw forbidden('This school identity is suspended. Contact a club officer.');
    }
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
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: {
            ':lastSeenAt': timestamp,
          },
          Key: profileKey(existing.id),
          ReturnValues: 'ALL_NEW',
          TableName: this.tableName,
          UpdateExpression: 'SET lastSeenAt = :lastSeenAt',
        }),
      );
      return normalizeMember(withoutStorageKeys<Member>(result.Attributes as Item) as Member);
    }

    if (existingMemberId) {
      throw new Error('Identity lookup points to a missing member profile.');
    }

    const handle = generatedMemberHandle();
    const member: Member = {
      createdAt: timestamp,
      displayName: identity.displayName,
      email: identity.email,
      handle,
      id: randomUUID(),
      identityProvider: identity.provider,
      identitySubject: identity.subject,
      ...(identity.tenantId ? { identityTenant: identity.tenantId } : {}),
      isPublicProfile: false,
      lastSeenAt: timestamp,
      minors: [],
      newsletterOptIn: false,
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
      new GetCommand({ ConsistentRead: true, Key: profileKey(memberId), TableName: this.tableName }),
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

  public async listPublicDirectoryMembers(
    limit: number,
    cursor?: string,
  ): Promise<Page<Member>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':partition': 'MEMBERS#PUBLIC',
          ':prefix': 'HANDLE#',
          ':public': true,
        },
        FilterExpression: '#status = :active AND isPublicProfile = :public',
        IndexName: 'gsi2',
        KeyConditionExpression: 'gsi2pk = :partition AND begins_with(gsi2sk, :prefix)',
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

  public async updateMemberProfile(
    member: Member,
    patch: UpdateMemberProfileInput,
  ): Promise<Member> {
    const timestamp = now();
    const nextHandle = patch.handle ?? member.handle;
    const nextIsPublic = patch.isPublicProfile ?? member.isPublicProfile;
    const preferenceAudit = preferenceAuditPut(this.tableName, member, patch, timestamp);
    const directoryFields =
      nextIsPublic && member.status === 'active'
        ? publicDirectoryIndex(nextHandle)
        : { gsi2pk: null, gsi2sk: null };
    const updatePatch = {
      ...patch,
      ...directoryFields,
      gsi1sk: `HANDLE#${nextHandle}#${member.id}`,
      updatedAt: timestamp,
    };

    let updated: Member;
    if (nextHandle === member.handle) {
      if (!preferenceAudit) {
        updated = normalizeMember(
          await this.updateAndReturn<Member>(profileKey(member.id), updatePatch),
        );
      } else {
        const update = buildUpdate(updatePatch);
        const concurrency = preferenceConcurrencyCondition(member);
        try {
          await this.documentClient.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    ConditionExpression: `attribute_exists(pk) AND ${concurrency.expression}`,
                    ExpressionAttributeNames: {
                      ...update.names,
                      ...concurrency.names,
                    },
                    ExpressionAttributeValues: {
                      ...update.values,
                      ...concurrency.values,
                    },
                    Key: profileKey(member.id),
                    TableName: this.tableName,
                    UpdateExpression: update.expression,
                  },
                },
                { Put: preferenceAudit },
              ],
            }),
          );
        } catch (error) {
          if (isConditionalFailure(error)) {
            throw conflict('Your privacy choices changed in another request. Refresh and retry.');
          }
          throw error;
        }
        const changedMember = await this.getMember(member.id);
        if (!changedMember) throw notFound('Member');
        updated = changedMember;
      }
    } else {
      const update = buildUpdate(updatePatch);
      const concurrency = preferenceAudit
        ? preferenceConcurrencyCondition(member)
        : undefined;
      const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        {
          Put: {
            ConditionExpression: 'attribute_not_exists(pk)',
            Item: {
              entityType: 'HandleLookup',
              memberId: member.id,
              pk: key('HANDLE', nextHandle),
              sk: 'LOOKUP',
            },
            TableName: this.tableName,
          },
        },
        {
          Update: {
            ConditionExpression: [
              '#currentHandle = :currentHandle',
              ...(concurrency ? [concurrency.expression] : []),
            ].join(' AND '),
            ExpressionAttributeNames: {
              ...update.names,
              ...(concurrency?.names ?? {}),
              '#currentHandle': 'handle',
            },
            ExpressionAttributeValues: {
              ...update.values,
              ...(concurrency?.values ?? {}),
              ':currentHandle': member.handle,
            },
            Key: profileKey(member.id),
            TableName: this.tableName,
            UpdateExpression: update.expression,
          },
        },
        {
          Delete: {
            ConditionExpression: 'memberId = :memberId',
            ExpressionAttributeValues: { ':memberId': member.id },
            Key: { pk: key('HANDLE', member.handle), sk: 'LOOKUP' },
            TableName: this.tableName,
          },
        },
      ];
      if (preferenceAudit) transactionItems.push({ Put: preferenceAudit });
      try {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: transactionItems }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw conflict(
            'That handle is unavailable or your privacy choices changed. Refresh and retry.',
          );
        }
        throw error;
      }
      const changedMember = await this.getMember(member.id);
      if (!changedMember) throw notFound('Member');
      updated = changedMember;
    }

    if (patch.handle !== undefined) {
      await this.refreshMemberHandleSnapshots(updated);
    }
    return updated;
  }

  public async updateMemberAvatar(
    member: Member,
    avatarUrl: string | null,
  ): Promise<Member> {
    const update = buildUpdate({ avatarUrl, updatedAt: now() });
    const hasCurrentAvatar = member.avatarUrl !== undefined;
    try {
      const result = await this.documentClient.send(
        new UpdateCommand({
          ConditionExpression: hasCurrentAvatar
            ? 'attribute_exists(pk) AND #currentAvatar = :currentAvatar'
            : 'attribute_exists(pk) AND attribute_not_exists(#currentAvatar)',
          ExpressionAttributeNames: {
            ...update.names,
            '#currentAvatar': 'avatarUrl',
          },
          ExpressionAttributeValues: {
            ...update.values,
            ...(hasCurrentAvatar ? { ':currentAvatar': member.avatarUrl } : {}),
          },
          Key: profileKey(member.id),
          ReturnValues: 'ALL_NEW',
          TableName: this.tableName,
          UpdateExpression: update.expression,
        }),
      );
      return normalizeMember(
        withoutStorageKeys<Member>(result.Attributes as Item) as Member,
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('Your avatar changed in another request. Refresh and try again.');
      }
      throw error;
    }
  }

  public async administerMember(
    memberId: string,
    changes: { role?: ClubRole; status?: MemberStatus },
    actor: Member,
  ): Promise<Member> {
    const existing = await this.getMember(memberId);
    if (!existing) throw notFound('Member');
    const timestamp = now();
    const nextStatus = changes.status ?? existing.status;
    const directoryFields =
      nextStatus === 'active' && existing.isPublicProfile
        ? publicDirectoryIndex(existing.handle)
        : { gsi2pk: null, gsi2sk: null };
    const update = buildUpdate({ ...changes, ...directoryFields, updatedAt: timestamp });
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ConditionExpression:
                  'attribute_exists(pk) AND #currentRole = :currentRole AND #currentStatus = :currentStatus',
                ExpressionAttributeNames: {
                  ...update.names,
                  '#currentRole': 'role',
                  '#currentStatus': 'status',
                },
                ExpressionAttributeValues: {
                  ...update.values,
                  ':currentRole': existing.role,
                  ':currentStatus': existing.status,
                },
                Key: profileKey(memberId),
                TableName: this.tableName,
                UpdateExpression: update.expression,
              },
            },
            {
              Put: {
                ConditionExpression: 'attribute_not_exists(pk)',
                Item: {
                  actorId: actor.id,
                  changes: {
                    ...(changes.role === undefined
                      ? {}
                      : { role: { from: existing.role, to: changes.role } }),
                    ...(changes.status === undefined
                      ? {}
                      : { status: { from: existing.status, to: changes.status } }),
                  },
                  createdAt: timestamp,
                  entityType: 'MemberAdministrationAudit',
                  id: randomUUID(),
                  pk: key('MEMBER_AUDIT', memberId),
                  sk: `AUDIT#${timestamp}#${randomUUID()}`,
                  targetMemberId: memberId,
                },
                TableName: this.tableName,
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('The member role or status changed; review and retry.');
      }
      throw error;
    }
    const updated = await this.getMember(memberId);
    if (!updated) throw notFound('Member');
    return updated;
  }

  public async exportMemberData(memberId: string): Promise<MemberPrivacyExport> {
    const profile = await this.getMember(memberId);
    if (!profile) throw notFound('Member');
    const userItems = await this.queryAllRaw({
      ExpressionAttributeValues: { ':partition': key('USER', memberId) },
      KeyConditionExpression: 'pk = :partition',
    });
    const linkedItems = await this.queryAllRaw({
      ExpressionAttributeValues: { ':partition': key('USER', memberId) },
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition',
    });

    const notifications = userItems
      .filter((item) => item.entityType === 'Notification')
      .map((item) => withoutStorageKeys<Notification>(item) as Notification);
    const invitations = userItems
      .filter((item) => item.entityType === 'MembershipInvitation')
      .map((item) => withoutStorageKeys<MembershipInvitation>(item) as MembershipInvitation);
    const memberships = linkedItems
      .filter(
        (item) =>
          item.entityType === 'ProjectMembership' || item.entityType === 'TeamMembership',
      )
      .map((item) => withoutStorageKeys<ResourceMembership>(item) as ResourceMembership);
    const eventRsvps = linkedItems
      .filter((item) => item.entityType === 'EventRsvp')
      .map((item) => withoutStorageKeys<EventRsvp>(item) as EventRsvp);
    const preferenceHistory = userItems
      .filter((item) => item.entityType === 'MemberPreferenceAudit')
      .map(
        (item) =>
          withoutStorageKeys<MemberPreferenceAuditEntry>(item) as MemberPreferenceAuditEntry,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      eventRsvps,
      generatedAt: now(),
      invitations,
      limitations: [
        'Membership and administrative audit records retain pseudonymous member UUIDs for integrity and are not included in this self-service export.',
        'Legacy event RSVPs created before the privacy index was introduced may require an officer-assisted export.',
        'Member-authored or owned project/team content, sent invitations and join-action history, resource audit snapshots, newsletter authorship, and historical notification snapshots require an officer-assisted search because they are not indexed by member.',
      ],
      memberships,
      notifications,
      preferenceHistory,
      profile,
    };
  }

  public async deleteMemberPersonalData(member: Member): Promise<void> {
    const userItems = await this.queryAllRaw({
      ExpressionAttributeValues: { ':partition': key('USER', member.id) },
      KeyConditionExpression: 'pk = :partition',
    });
    const linkedItems = await this.queryAllRaw({
      ExpressionAttributeValues: { ':partition': key('USER', member.id) },
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition',
    });

    for (const item of linkedItems) {
      if (item.entityType === 'ProjectMembership' || item.entityType === 'TeamMembership') {
        await this.removePersonalDataFromMembership(item, member);
      } else if (item.entityType === 'EventRsvp') {
        await this.documentClient.send(
          new DeleteCommand({
            Key: storageKey(item),
            TableName: this.tableName,
          }),
        );
      }
    }

    for (const item of userItems) {
      if (item.sk === 'PROFILE') continue;
      await this.documentClient.send(
        new DeleteCommand({ Key: storageKey(item), TableName: this.tableName }),
      );
    }

    const timestamp = now();
    await this.documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          member.status === 'suspended' ? {
            // Keep only the enforcement marker, not the deleted member's profile.
            // Registration reads this same key before it can create a new account.
            Put: {
              Item: {
                pk: `IDENTITY#${member.identityProvider}#${member.identitySubject}`,
                sk: 'LOOKUP',
                entityType: 'SuspendedIdentity',
                suspended: true,
              },
              TableName: this.tableName,
            },
          } : {
            Delete: {
              Key: {
                pk: `IDENTITY#${member.identityProvider}#${member.identitySubject}`,
                sk: 'LOOKUP',
              },
              TableName: this.tableName,
            },
          },
          {
            Delete: {
              Key: emailLookupKey(member.email),
              TableName: this.tableName,
            },
          },
          {
            Delete: {
              Key: { pk: key('HANDLE', member.handle), sk: 'LOOKUP' },
              TableName: this.tableName,
            },
          },
          {
            Delete: {
              ConditionExpression: '#status = :expectedStatus AND handle = :expectedHandle',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':expectedStatus': member.status,
                ':expectedHandle': member.handle,
              },
              Key: profileKey(member.id),
              TableName: this.tableName,
            },
          },
          {
            Put: {
              ConditionExpression: 'attribute_not_exists(pk)',
              Item: {
                createdAt: timestamp,
                entityType: 'MemberDeletionAudit',
                memberReference: createHash('sha256').update(member.id).digest('hex'),
                pk: 'PRIVACY_AUDIT',
                sk: `DELETION#${timestamp}#${randomUUID()}`,
              },
              TableName: this.tableName,
            },
          },
        ],
      }),
    ).catch((error: unknown) => {
      if (isConditionalFailure(error)) {
        throw conflict('Your account status or handle changed during deletion. Refresh and retry.');
      }
      throw error;
    });
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
          eventId: event.id,
          gsi2pk: key('USER', member.id),
          gsi2sk: `RSVP#EVENT#${event.id}`,
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

  public async getMemberEventRsvp(eventId: string, memberId: string): Promise<EventRsvp | undefined> {
    return withoutStorageKeys<EventRsvp>(await this.getRaw({
      pk: key('EVENT', eventId), sk: key('MEMBER', memberId),
    }));
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

  public async claimNewsletterDelivery(
    newsletterId: string,
    memberId: string,
  ): Promise<string | undefined> {
    const claimedAtDate = new Date();
    const claimedAt = claimedAtDate.toISOString();
    const leaseExpiresAt = new Date(
      claimedAtDate.getTime() + NEWSLETTER_DELIVERY_LEASE_MS,
    ).toISOString();
    const claimToken = randomUUID();
    try {
      await this.documentClient.send(
        new UpdateCommand({
          ConditionExpression:
            'attribute_not_exists(pk) OR (#outcome = :claimed AND leaseExpiresAt < :claimedAt) OR #outcome = :retryPending',
          ExpressionAttributeNames: { '#outcome': 'outcome' },
          ExpressionAttributeValues: {
            ':claimed': 'claimed',
            ':claimedAt': claimedAt,
            ':claimToken': claimToken,
            ':entityType': 'NewsletterDelivery',
            ':leaseExpiresAt': leaseExpiresAt,
            ':memberId': memberId,
            ':retryPending': 'retry_pending',
          },
          Key: newsletterDeliveryKey(newsletterId, memberId),
          TableName: this.tableName,
          UpdateExpression:
            'SET claimedAt = :claimedAt, claimToken = :claimToken, entityType = :entityType, leaseExpiresAt = :leaseExpiresAt, memberId = :memberId, #outcome = :claimed REMOVE attemptStartedAt, completedAt, providerMessageId',
        }),
      );
      return claimToken;
    } catch (error) {
      if (isConditionalFailure(error)) return undefined;
      throw error;
    }
  }

  public async beginNewsletterDeliveryAttempt(
    newsletterId: string,
    memberId: string,
    claimToken: string,
  ): Promise<boolean> {
    const attemptStartedAt = now();
    try {
      await this.documentClient.send(
        new UpdateCommand({
          ConditionExpression:
            '#outcome = :claimed AND claimToken = :claimToken AND leaseExpiresAt >= :attemptStartedAt',
          ExpressionAttributeNames: { '#outcome': 'outcome' },
          ExpressionAttributeValues: {
            ':acceptedUnconfirmed': 'accepted_unconfirmed',
            ':attemptStartedAt': attemptStartedAt,
            ':claimed': 'claimed',
            ':claimToken': claimToken,
          },
          Key: newsletterDeliveryKey(newsletterId, memberId),
          TableName: this.tableName,
          UpdateExpression:
            'SET #outcome = :acceptedUnconfirmed, attemptStartedAt = :attemptStartedAt REMOVE leaseExpiresAt',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  public async completeNewsletterDelivery(
    newsletterId: string,
    memberId: string,
    outcome: 'sent' | 'skipped',
    claimToken: string,
    providerMessageId?: string,
  ): Promise<Newsletter> {
    const timestamp = now();
    const expectedOutcome = outcome === 'sent' ? 'accepted_unconfirmed' : 'claimed';
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ConditionExpression:
                  outcome === 'skipped'
                    ? '#outcome = :expectedOutcome AND claimToken = :claimToken AND leaseExpiresAt >= :completedAt'
                    : '#outcome = :expectedOutcome AND claimToken = :claimToken',
                ExpressionAttributeNames: { '#outcome': 'outcome' },
                ExpressionAttributeValues: {
                  ':completedAt': timestamp,
                  ':claimToken': claimToken,
                  ':expectedOutcome': expectedOutcome,
                  ':nextOutcome': outcome,
                  ...(providerMessageId ? { ':providerMessageId': providerMessageId } : {}),
                },
                Key: newsletterDeliveryKey(newsletterId, memberId),
                TableName: this.tableName,
                UpdateExpression: providerMessageId
                  ? 'SET #outcome = :nextOutcome, completedAt = :completedAt, providerMessageId = :providerMessageId REMOVE claimToken, leaseExpiresAt'
                  : 'SET #outcome = :nextOutcome, completedAt = :completedAt REMOVE claimToken, leaseExpiresAt',
              },
            },
            {
              Update: {
                ConditionExpression: 'attribute_exists(pk)',
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

  public async releaseNewsletterDeliveryClaim(
    newsletterId: string,
    memberId: string,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.documentClient.send(
        new DeleteCommand({
          ConditionExpression: '#outcome = :claimed AND claimToken = :claimToken',
          ExpressionAttributeNames: { '#outcome': 'outcome' },
          ExpressionAttributeValues: {
            ':claimed': 'claimed',
            ':claimToken': claimToken,
          },
          Key: newsletterDeliveryKey(newsletterId, memberId),
          TableName: this.tableName,
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  public async listNewsletterDeliveries(
    newsletterId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<NewsletterDelivery>> {
    const result = await this.documentClient.send(
      new QueryCommand({
        ExclusiveStartKey: decodeCursor(cursor),
        ExpressionAttributeValues: {
          ':partition': key('NEWSLETTER', newsletterId),
          ':prefix': 'DELIVERY#',
        },
        KeyConditionExpression: 'pk = :partition AND begins_with(sk, :prefix)',
        Limit: limit,
        TableName: this.tableName,
      }),
    );
    const items = (result.Items ?? []).map((item) => toNewsletterDelivery(item as Item));
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  public async reconcileNewsletterDelivery(
    newsletterId: string,
    memberId: string,
    reconciliation: {
      acknowledgePossibleDuplicate?: boolean | undefined;
      reason: string;
      resolution: 'mark_sent' | 'mark_skipped' | 'retry';
    },
    actor: Member,
  ): Promise<Newsletter> {
    const timestamp = now();
    const deliveryKey = newsletterDeliveryKey(newsletterId, memberId);
    const { acknowledgePossibleDuplicate, reason, resolution } = reconciliation;
    if (resolution === 'retry' && acknowledgePossibleDuplicate !== true) {
      throw badRequest('Retry requires acknowledgement of the possible duplicate delivery.');
    }

    if (resolution === 'retry') {
      try {
        await this.documentClient.send(
          new UpdateCommand({
            ConditionExpression:
              '#outcome = :acceptedUnconfirmed OR #outcome = :legacySending OR #outcome = :retryPending',
            ExpressionAttributeNames: { '#outcome': 'outcome' },
            ExpressionAttributeValues: {
              ':acceptedUnconfirmed': 'accepted_unconfirmed',
              ':duplicateRiskAcknowledged': acknowledgePossibleDuplicate === true,
              ':legacySending': 'sending',
              ':reconciledAt': timestamp,
              ':reconciledBy': actor.id,
              ':reason': reason,
              ':resolution': resolution,
              ':retryPending': 'retry_pending',
            },
            Key: deliveryKey,
            TableName: this.tableName,
            UpdateExpression:
              'SET #outcome = :retryPending, duplicateRiskAcknowledged = :duplicateRiskAcknowledged, reconciledAt = :reconciledAt, reconciledBy = :reconciledBy, reconciliationReason = :reason, reconciliationResolution = :resolution REMOVE claimToken, leaseExpiresAt',
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw conflict('This delivery is no longer waiting for reconciliation.');
        }
        throw error;
      }
    } else {
      const outcome = resolution === 'mark_sent' ? 'sent' : 'skipped';
      try {
        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  ConditionExpression:
                    '#outcome = :acceptedUnconfirmed OR #outcome = :legacySending',
                  ExpressionAttributeNames: { '#outcome': 'outcome' },
                  ExpressionAttributeValues: {
                    ':acceptedUnconfirmed': 'accepted_unconfirmed',
                    ':completedAt': timestamp,
                    ':legacySending': 'sending',
                    ':nextOutcome': outcome,
                    ':reconciledAt': timestamp,
                    ':reconciledBy': actor.id,
                    ':reason': reason,
                    ':resolution': resolution,
                  },
                  Key: deliveryKey,
                  TableName: this.tableName,
                  UpdateExpression:
                    'SET #outcome = :nextOutcome, completedAt = :completedAt, reconciledAt = :reconciledAt, reconciledBy = :reconciledBy, reconciliationReason = :reason, reconciliationResolution = :resolution REMOVE claimToken, leaseExpiresAt',
                },
              },
              {
                Update: {
                  ConditionExpression: 'attribute_exists(pk)',
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
        const existing = await this.getRaw(deliveryKey);
        if (existing?.outcome !== outcome) {
          throw conflict('This delivery is no longer waiting for reconciliation.');
        }
      }
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
          ':optedIn': true,
          ':partition': 'MEMBERS',
        },
        FilterExpression: '#status = :active AND newsletterOptIn = :optedIn',
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

  private async queryAllRaw(
    input: Omit<QueryCommandInput, 'ExclusiveStartKey' | 'TableName'>,
  ): Promise<Item[]> {
    const items: Item[] = [];
    let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
    do {
      const result = await this.documentClient.send(
        new QueryCommand({
          ...input,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          TableName: this.tableName,
        }),
      );
      items.push(...((result.Items ?? []) as Item[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  private async refreshMemberHandleSnapshots(member: Member): Promise<void> {
    const items = await this.queryAllRaw({
      ExpressionAttributeValues: { ':partition': key('USER', member.id) },
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :partition',
    });

    for (const item of items) {
      if (item.entityType === 'EventRsvp') {
        await this.documentClient.send(
          new UpdateCommand({
            ConditionExpression: 'memberId = :memberId',
            ExpressionAttributeValues: {
              ':memberHandle': member.handle,
              ':memberId': member.id,
            },
            Key: storageKey(item),
            TableName: this.tableName,
            UpdateExpression: 'SET memberHandle = :memberHandle',
          }),
        );
        continue;
      }
      if (item.entityType !== 'ProjectMembership' && item.entityType !== 'TeamMembership') {
        continue;
      }
      const resourceType: ResourceType =
        item.entityType === 'ProjectMembership' ? 'project' : 'team';
      const resourceId: unknown = item.resourceId;
      if (typeof resourceId !== 'string') {
        throw new Error('A member relationship has invalid resource metadata.');
      }

      let updated = false;
      for (let attempt = 0; attempt < 3 && !updated; attempt += 1) {
        const resource =
          resourceType === 'project'
            ? await this.getProject(resourceId)
            : await this.getTeam(resourceId);
        const memberIndex = resource?.memberIds.indexOf(member.id) ?? -1;
        const relationshipUpdate: TransactionUpdate = {
          ConditionExpression: 'memberId = :memberId',
          ExpressionAttributeValues: {
            ':memberHandle': member.handle,
            ':memberId': member.id,
          },
          Key: storageKey(item),
          TableName: this.tableName,
          UpdateExpression: 'SET memberHandle = :memberHandle',
        };
        const transactionItems: TransactionItem[] = [{ Update: relationshipUpdate }];
        if (resource && memberIndex >= 0) {
          const nextHandles = [...resource.memberHandles];
          nextHandles[memberIndex] = member.handle;
          transactionItems.push({
            Update: this.replaceResourceMembersUpdate(
              resourceType,
              resource,
              resource.memberIds,
              nextHandles,
              now(),
            ),
          });
        }
        try {
          await this.documentClient.send(
            new TransactWriteCommand({ TransactItems: transactionItems }),
          );
          updated = true;
        } catch (error) {
          if (!isConditionalFailure(error) || attempt === 2) throw error;
        }
      }
    }
  }

  private async removePersonalDataFromMembership(item: Item, member: Member): Promise<void> {
    const resourceType: unknown = item.resourceType;
    const resourceId: unknown = item.resourceId;
    if (
      (resourceType !== 'project' && resourceType !== 'team') ||
      typeof resourceId !== 'string'
    ) {
      throw new Error('A member relationship has invalid resource metadata.');
    }
    const relationshipKey = storageKey(item);
    const resource =
      resourceType === 'project'
        ? await this.getProject(resourceId)
        : await this.getTeam(resourceId);
    if (!resource) {
      await this.documentClient.send(
        new DeleteCommand({ Key: relationshipKey, TableName: this.tableName }),
      );
      return;
    }

    const index = resource.memberIds.indexOf(member.id);
    if (resource.ownerId === member.id) {
      const nextHandles = [...resource.memberHandles];
      if (index >= 0) nextHandles[index] = 'deleted-member';
      const transactionItems: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
      > = [];
      if (index >= 0) {
        transactionItems.push({
          Update: this.replaceResourceMembersUpdate(
            resourceType,
            resource,
            resource.memberIds,
            nextHandles,
            now(),
          ),
        });
      }
      transactionItems.push({
        Update: {
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':deletedHandle': 'deleted-member' },
          Key: relationshipKey,
          TableName: this.tableName,
          UpdateExpression: 'SET memberHandle = :deletedHandle REMOVE gsi2pk, gsi2sk',
        },
      });
      try {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: transactionItems }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) {
          throw conflict('An owned club resource changed during account deletion; retry.');
        }
        throw error;
      }
      return;
    }

    if (index < 0) {
      await this.documentClient.send(
        new DeleteCommand({ Key: relationshipKey, TableName: this.tableName }),
      );
      return;
    }
    const nextMemberIds = resource.memberIds.filter((id) => id !== member.id);
    const nextMemberHandles = resource.memberHandles.filter((_, itemIndex) => itemIndex !== index);
    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: this.replaceResourceMembersUpdate(
                resourceType,
                resource,
                nextMemberIds,
                nextMemberHandles,
                now(),
              ),
            },
            {
              Delete: {
                ConditionExpression: 'attribute_exists(pk)',
                Key: relationshipKey,
                TableName: this.tableName,
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw conflict('A club resource changed during account deletion; retry the request.');
      }
      throw error;
    }
  }

  private async getEntity<T>(kind: EntityKind, id: string): Promise<T | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({ Key: entityKey(kind, id), TableName: this.tableName }),
    );
    return withoutStorageKeys<T>(result.Item as Item | undefined);
  }

  private async getRaw(itemKey: Record<'pk' | 'sk', string>): Promise<Item | undefined> {
    const result = await this.documentClient.send(
      new GetCommand({ ConsistentRead: true, Key: itemKey, TableName: this.tableName }),
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

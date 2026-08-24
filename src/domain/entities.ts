import { isAllowedProfileUrl } from './profile-links.js';

export const CLUB_ROLES = [
  'member',
  'reservation_designee',
  'treasurer',
  'vice_president',
  'president',
] as const;

export type ClubRole = (typeof CLUB_ROLES)[number];
export type MemberStatus = 'active' | 'suspended';
export type IdentityProvider = 'entra' | 'cognito';

export interface Member {
  id: string;
  identityProvider: IdentityProvider;
  identitySubject: string;
  identityTenant?: string;
  email: string;
  handle: string;
  displayName: string;
  isPublicProfile: boolean;
  newsletterOptIn: boolean;
  role: ClubRole;
  status: MemberStatus;
  bio?: string;
  avatarUrl?: string;
  githubUrl?: string;
  linkedinUrl?: string;
  major?: string;
  minors: string[];
  techStack: string[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export const CURRENT_PRIVACY_POLICY_VERSION = '2026-08-23-v1' as const;

export interface MemberPreferenceAuditEntry {
  id: string;
  actorMemberId: string;
  memberId: string;
  changes: {
    isPublicProfile?: { from: boolean; to: boolean };
    newsletterOptIn?: { from: boolean; to: boolean };
  };
  createdAt: string;
  policyVersion: typeof CURRENT_PRIVACY_POLICY_VERSION;
  source: 'self_service_profile';
}

export type PublicMember = Pick<Member, 'displayName' | 'handle' | 'id'>;

export type PublicDirectoryMember = Pick<
  Member,
  | 'avatarUrl'
  | 'bio'
  | 'displayName'
  | 'githubUrl'
  | 'handle'
  | 'linkedinUrl'
  | 'major'
  | 'minors'
  | 'techStack'
>;

export type PublicationStatus = 'draft' | 'pending_review' | 'published' | 'archived';

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  repoUrl?: string;
  imageUrl?: string;
  demoUrl?: string;
  techStack: string[];
  status: PublicationStatus;
  memberIds: string[];
  memberHandles: string[];
  createdAt: string;
  updatedAt: string;
}

export type PublicProject = Omit<Project, 'memberHandles' | 'memberIds' | 'ownerId'>;

export type TeamStatus = 'open' | 'closed' | 'archived';
export type JoinPolicy = 'open' | 'approval_required';

export interface Team {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  category: 'hackathon' | 'ctf' | 'project' | 'study_group' | 'other';
  status: TeamStatus;
  joinPolicy: JoinPolicy;
  maxMembers: number;
  memberCount: number;
  memberIds: string[];
  memberHandles: string[];
  imageUrl?: string;
  eventId?: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicTeam = Omit<Team, 'memberHandles' | 'memberIds' | 'ownerId'>;

export interface ClubEvent {
  id: string;
  name: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  imageUrl?: string;
  published: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export type PublicClubEvent = Omit<ClubEvent, 'createdBy'>;

export interface EventRsvp {
  eventId?: string;
  memberId: string;
  memberHandle: string;
  status: 'going' | 'maybe';
  updatedAt: string;
}

export type NewsletterStatus = 'queued' | 'sending' | 'sent' | 'queue_failed';

export interface Newsletter {
  id: string;
  subject: string;
  body: string;
  createdBy: string;
  createdByHandle: string;
  status: NewsletterStatus;
  recipientCount: number;
  processedCount: number;
  sentCount: number;
  skippedCount: number;
  fanoutComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewsletterDeliveryOutcome =
  | 'claimed'
  | 'accepted_unconfirmed'
  | 'retry_pending'
  | 'sent'
  | 'skipped'
  | 'sending';

export interface NewsletterDelivery {
  memberId: string;
  outcome: NewsletterDeliveryOutcome;
  claimedAt?: string;
  leaseExpiresAt?: string;
  attemptStartedAt?: string;
  completedAt?: string;
  providerMessageId?: string;
  reconciledAt?: string;
  reconciledBy?: string;
  reconciliationResolution?: 'mark_sent' | 'mark_skipped' | 'retry';
  reconciliationReason?: string;
  duplicateRiskAcknowledged?: boolean;
}

export type MembershipStatus = 'invited' | 'requested' | 'active' | 'rejected' | 'removed';
export type JoinRequestStatus = Extract<MembershipStatus, 'requested' | 'active' | 'rejected'>;
export type ResourceType = 'project' | 'team';
export type ResourceMembershipRole = 'owner' | 'contributor' | 'member';

export interface ResourceMembership {
  resourceType: ResourceType;
  resourceId: string;
  memberId: string;
  memberHandle: string;
  role: ResourceMembershipRole;
  status: MembershipStatus;
  initiatedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipInvitation {
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  invitedById: string;
  invitedByHandle: string;
  createdAt: string;
}

export interface MembershipAuditEntry {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  action:
    | 'requested'
    | 'invited'
    | 'invitation_revoked'
    | 'added'
    | 'accepted'
    | 'declined'
    | 'rejected'
    | 'removed'
    | 'left'
    | 'request_withdrawn'
    | 'ownership_transferred';
  actorId: string;
  targetMemberId: string;
  createdAt: string;
}

export interface MemberPrivacyExport {
  eventRsvps: EventRsvp[];
  generatedAt: string;
  invitations: MembershipInvitation[];
  limitations: string[];
  memberships: ResourceMembership[];
  notifications: Notification[];
  preferenceHistory: MemberPreferenceAuditEntry[];
  profile: Member;
}

export type NotificationType =
  | 'resource_join_requested'
  | 'resource_join_withdrawn'
  | 'resource_join_approved'
  | 'resource_join_rejected';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  createdAt: string;
  readAt?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface AuthenticatedIdentity {
  provider: IdentityProvider;
  subject: string;
  tenantId?: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
}

export function toPublicMember(member: Member): PublicMember {
  return { displayName: member.displayName, handle: member.handle, id: member.id };
}

export function toPublicDirectoryMember(member: Member): PublicDirectoryMember {
  return {
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    ...(member.bio ? { bio: member.bio } : {}),
    displayName: member.displayName,
    ...(member.githubUrl && isAllowedProfileUrl(member.githubUrl, 'github')
      ? { githubUrl: member.githubUrl }
      : {}),
    handle: member.handle,
    ...(member.linkedinUrl && isAllowedProfileUrl(member.linkedinUrl, 'linkedin')
      ? { linkedinUrl: member.linkedinUrl }
      : {}),
    ...(member.major ? { major: member.major } : {}),
    minors: member.minors,
    techStack: member.techStack,
  };
}

export function toPublicProject(project: Project): PublicProject {
  const {
    memberHandles: _memberHandles,
    memberIds: _memberIds,
    ownerId: _ownerId,
    ...publicProject
  } = project;
  return publicProject;
}

export function toPublicTeam(team: Team): PublicTeam {
  const {
    memberHandles: _memberHandles,
    memberIds: _memberIds,
    ownerId: _ownerId,
    ...publicTeam
  } = team;
  return publicTeam;
}

export function toPublicEvent(event: ClubEvent): PublicClubEvent {
  const { createdBy: _createdBy, ...publicEvent } = event;
  return publicEvent;
}

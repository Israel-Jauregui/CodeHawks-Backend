import type {
  AuthenticatedIdentity,
  ClubEvent,
  ClubRole,
  EventRsvp,
  JoinRequestStatus,
  Member,
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
import type {
  createEventSchema,
  createNewsletterSchema,
  createProjectSchema,
  createTeamSchema,
  memberProfilePatchSchema,
  updateEventSchema,
  updateProjectSchema,
  updateTeamSchema,
} from '../domain/schemas.js';
import type { z } from 'zod';

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type CreateNewsletterInput = z.infer<typeof createNewsletterSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type UpdateMemberProfileInput = z.infer<typeof memberProfilePatchSchema>;

export interface ClubRepository {
  ensureMember(identity: AuthenticatedIdentity): Promise<Member>;
  getMember(memberId: string): Promise<Member | undefined>;
  listMembers(search: string, limit: number, cursor?: string): Promise<Page<Member>>;
  listPublicDirectoryMembers(limit: number, cursor?: string): Promise<Page<Member>>;
  updateMemberProfile(member: Member, patch: UpdateMemberProfileInput): Promise<Member>;
  updateMemberAvatar(member: Member, avatarUrl: string | null): Promise<Member>;
  exportMemberData(memberId: string): Promise<MemberPrivacyExport>;
  deleteMemberPersonalData(member: Member): Promise<void>;
  administerMember(
    memberId: string,
    changes: { role?: ClubRole; status?: MemberStatus },
    actor: Member,
  ): Promise<Member>;
  listMemberNotifications(
    memberId: string,
    read: boolean | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Notification>>;
  updateNotificationReadState(
    memberId: string,
    notificationId: string,
    read: boolean,
  ): Promise<Notification>;

  createProject(actor: Member, input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | undefined>;
  listProjects(limit: number, cursor?: string): Promise<Page<Project>>;
  listManagedProjects(
    status: PublicationStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Project>>;
  updateProject(project: Project, patch: UpdateProjectInput): Promise<Project>;
  archiveProject(project: Project): Promise<void>;
  requestProjectMembership(project: Project, member: Member): Promise<'requested' | 'already-member' | 'already-requested'>;
  reviewProjectMembership(
    project: Project,
    actor: Member,
    memberId: string,
    status: Exclude<JoinRequestStatus, 'requested'>,
  ): Promise<Project>;

  createTeam(actor: Member, input: CreateTeamInput): Promise<Team>;
  getTeam(teamId: string): Promise<Team | undefined>;
  listTeams(limit: number, cursor?: string): Promise<Page<Team>>;
  listManagedTeams(
    status: TeamStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<Team>>;
  updateTeam(team: Team, patch: UpdateTeamInput): Promise<Team>;
  archiveTeam(team: Team): Promise<void>;
  requestTeamMembership(team: Team, member: Member): Promise<'joined' | 'requested' | 'already-member' | 'already-requested'>;
  reviewTeamMembership(
    team: Team,
    actor: Member,
    memberId: string,
    status: Exclude<JoinRequestStatus, 'requested'>,
  ): Promise<Team>;

  createEvent(actor: Member, input: CreateEventInput): Promise<ClubEvent>;
  getEvent(eventId: string): Promise<ClubEvent | undefined>;
  listEvents(limit: number, cursor?: string): Promise<Page<ClubEvent>>;
  listManagedEvents(limit: number, cursor?: string): Promise<Page<ClubEvent>>;
  updateEvent(event: ClubEvent, patch: UpdateEventInput): Promise<ClubEvent>;
  archiveEvent(event: ClubEvent): Promise<void>;
  setEventRsvp(event: ClubEvent, member: Member, status: 'going' | 'maybe'): Promise<void>;
  removeEventRsvp(event: ClubEvent, member: Member): Promise<void>;
  listEventRsvps(eventId: string, limit: number, cursor?: string): Promise<Page<EventRsvp>>;
  getMemberEventRsvp(eventId: string, memberId: string): Promise<EventRsvp | undefined>;

  createNewsletter(actor: Member, input: CreateNewsletterInput): Promise<Newsletter>;
  getNewsletter(newsletterId: string): Promise<Newsletter | undefined>;
  listNewsletters(limit: number, cursor?: string): Promise<Page<Newsletter>>;
  updateNewsletterStatus(
    newsletterId: string,
    expectedStatus: NewsletterStatus,
    status: NewsletterStatus,
  ): Promise<Newsletter>;
  markNewsletterFanout(newsletterId: string, recipientCount: number): Promise<Newsletter>;
  claimNewsletterDelivery(newsletterId: string, memberId: string): Promise<string | undefined>;
  beginNewsletterDeliveryAttempt(
    newsletterId: string,
    memberId: string,
    claimToken: string,
  ): Promise<boolean>;
  completeNewsletterDelivery(
    newsletterId: string,
    memberId: string,
    outcome: 'sent' | 'skipped',
    claimToken: string,
    providerMessageId?: string,
  ): Promise<Newsletter>;
  releaseNewsletterDeliveryClaim(
    newsletterId: string,
    memberId: string,
    claimToken: string,
  ): Promise<void>;
  listNewsletterDeliveries(
    newsletterId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<NewsletterDelivery>>;
  reconcileNewsletterDelivery(
    newsletterId: string,
    memberId: string,
    reconciliation: {
      acknowledgePossibleDuplicate?: boolean | undefined;
      reason: string;
      resolution: 'mark_sent' | 'mark_skipped' | 'retry';
    },
    actor: Member,
  ): Promise<Newsletter>;
  listNewsletterRecipients(limit: number, cursor?: string): Promise<Page<Member>>;

  listResourceMemberships(
    resourceType: ResourceType,
    resourceId: string,
    status: MembershipStatus,
    limit: number,
    cursor?: string,
  ): Promise<Page<ResourceMembership>>;
  inviteResourceMember(
    resourceType: ResourceType,
    resource: Project | Team,
    actor: Member,
    target: Member,
  ): Promise<void>;
  addResourceMember(
    resourceType: ResourceType,
    resource: Project | Team,
    actor: Member,
    target: Member,
  ): Promise<Project | Team>;
  revokeResourceInvitation(
    resourceType: ResourceType,
    resourceId: string,
    actor: Member,
    targetMemberId: string,
  ): Promise<void>;
  withdrawResourceRequest(
    resourceType: ResourceType,
    resource: Project | Team,
    member: Member,
  ): Promise<void>;
  respondToResourceInvitation(
    resourceType: ResourceType,
    resource: Project | Team,
    member: Member,
    response: 'accepted' | 'declined',
  ): Promise<Project | Team>;
  removeResourceMember(
    resourceType: ResourceType,
    resource: Project | Team,
    actor: Member,
    targetMemberId: string,
    action: 'removed' | 'left',
  ): Promise<Project | Team>;
  transferResourceOwnership(
    resourceType: ResourceType,
    resource: Project | Team,
    actor: Member,
    target: Member,
  ): Promise<Project | Team>;
  listMemberInvitations(memberId: string, limit: number, cursor?: string): Promise<Page<MembershipInvitation>>;
  listMemberResourceMemberships(
    memberId: string,
    resourceType: ResourceType | undefined,
    status: MembershipStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<Page<ResourceMembership>>;
  listMembershipAudit(
    resourceType: ResourceType,
    resourceId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<MembershipAuditEntry>>;
}

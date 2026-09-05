# DynamoDB data model

The backend uses one on-demand table with partition key `pk`, sort key `sk`, and two sparse GSIs. Application entities use provider-neutral UUIDs; Microsoft `oid` and Cognito `sub` values exist only in identity lookup/profile metadata.

## Item shapes

| Entity | `pk` | `sk` | Purpose |
|---|---|---|---|
| Member | `USER#<member UUID>` | `PROFILE` | Private profile, club role/status, provider metadata, public-directory and newsletter choices |
| Identity lookup | `IDENTITY#<provider>#<subject>` | `LOOKUP` | Maps Entra `oid` or Cognito `sub` to member UUID |
| Deleted suspended identity | `IDENTITY#<provider>#<subject>` | `LOOKUP` | Minimal `SuspendedIdentity` marker; contains `suspended: true`, no profile, email, handle, or member UUID |
| Email lookup | `EMAIL#<sha256 normalized email>` | `LOOKUP` | Prevents duplicate accounts without exposing email in the key |
| Handle lookup | `HANDLE#<handle>` | `LOOKUP` | Reserves a unique random/user-chosen handle |
| Member preference audit | `USER#<member UUID>` | `PREFERENCE_AUDIT#<time>#<UUID>` | Old/new public-profile and newsletter choices, actor, source, and policy version |
| Member administration audit | `MEMBER_AUDIT#<member UUID>` | `AUDIT#<time>#<UUID>` | Actor-aware role/status change, without email/profile content |
| Member deletion audit | `PRIVACY_AUDIT` | `DELETION#<time>#<UUID>` | Nonpersonal hashed reference proving a deletion workflow completed |
| Invitation inbox | `USER#<member UUID>` | `INVITE#<type>#<resource UUID>` | Pending project/team invitation summary |
| Notification | `USER#<member UUID>` | `NOTIFICATION#<13-digit time>-<UUID>` | Newest-first join-request inbox event and optional read timestamp |
| Project | `PROJECT#<UUID>` | `METADATA` | Content, publication state, owner, active-member projection |
| Project membership | `PROJECT#<UUID>` | `MEMBER#<member UUID>` | Owner/contributor role and membership state |
| Project membership audit | `PROJECT#<UUID>` | `AUDIT#<time>#<UUID>` | Append-only membership action |
| Team | `TEAM#<UUID>` | `METADATA` | Content, capacity, join policy, owner, active-member projection |
| Team membership | `TEAM#<UUID>` | `MEMBER#<member UUID>` | Owner/member role and membership state |
| Team membership audit | `TEAM#<UUID>` | `AUDIT#<time>#<UUID>` | Append-only membership action |
| Event | `EVENT#<UUID>` | `METADATA` | Time, place, publication/archive state, creator |
| RSVP | `EVENT#<UUID>` | `MEMBER#<member UUID>` | Going/maybe state and member handle; new writes are indexed for export/deletion |
| Newsletter | `NEWSLETTER#<idempotency UUID>` | `METADATA` | Officer-authored content, status, and delivery counters |
| Newsletter delivery | `NEWSLETTER#<UUID>` | `DELIVERY#<member UUID>` | Leased claim, provider-attempt boundary, final outcome, and operator reconciliation record |

Membership records retain `invited`, `requested`, `active`, `rejected`, or `removed` state. This supports safe retries, withdrawal/rejoin behavior, and an auditable history without hard-deleting relationships.

## GSI access patterns

`gsi1` serves public discovery and member search:

| Query | `gsi1pk` | `gsi1sk` |
|---|---|---|
| Search active members by handle prefix | `MEMBERS` | `HANDLE#<handle>#<member UUID>` |
| List published projects newest first | `PROJECTS#PUBLISHED` | `CREATED#<ISO time>#<UUID>` |
| List non-archived teams newest first | `TEAMS#ACTIVE` | `CREATED#<ISO time>#<UUID>` |
| List published events chronologically | `EVENTS#PUBLISHED` | `START#<ISO time>#<UUID>` |

`gsi2` serves authenticated dashboards and management queues:

| Query | `gsi2pk` | `gsi2sk` |
|---|---|---|
| My project/team relationships | `USER#<member UUID>` | `RESOURCE#<TYPE>#<resource UUID>` |
| Public directory (sparse opt-in) | `MEMBERS#PUBLIC` | `HANDLE#<handle>` |
| My event RSVPs | `USER#<member UUID>` | `RSVP#EVENT#<event UUID>` |
| All projects, including drafts/review/archive | `RESOURCES#PROJECTS` | `CREATED#<ISO time>#<UUID>` |
| All teams, including archived | `RESOURCES#TEAMS` | `CREATED#<ISO time>#<UUID>` |
| All events, including drafts/archive | `RESOURCES#EVENTS` | `START#<ISO time>#<UUID>` |
| Newsletter history | `NEWSLETTERS` | `CREATED#<ISO time>#<UUID>` |
| Unread notifications | `USER#<member UUID>` | `NOTIFICATION#<13-digit time>-<UUID>` |

The API performs key/index queries, never table scans. Cursors are opaque base64url encodings of DynamoDB `LastEvaluatedKey` values and must not be constructed by clients. Filtered relationship/management pages can contain fewer results than their requested limit while still returning a next cursor.

## Consistency and concurrency

- Member profile, identity, email, and handle reservations are created in one transaction.
- A change to `isPublicProfile` or `newsletterOptIn` updates the profile and appends a `MemberPreferenceAudit` in one transaction. The record contains old/new values, the member as actor/subject, `self_service_profile` as source, and policy version `2026-08-23-v1`.
- Project/team metadata and the creator's owner relationship are created together.
- Requests, invitations, direct additions, removals, ownership transfers, and audit records use transactions.
- Team capacity is checked in the same conditional transaction that changes membership.
- Resource `updatedAt` values prevent concurrent projection changes from overwriting each other.
- Archived resources reject stale additions/approvals.
- Invitations have a resource relationship plus a user-partition inbox item; accepting, declining, revoking, or direct-adding removes the inbox item.
- Join-request creation/restoration, withdrawal, and review write their recipient notification in the same transaction as membership state and audit history. A direct add of an existing requester also records approval.
- Notification sort keys begin with a fixed-width Unix millisecond timestamp, so a reverse user-partition query returns the inbox newest first. Unread items also occupy a sparse `gsi2` entry; marking one read sets `readAt` and removes that entry, while marking it unread restores the entry. This makes the common unread query direct and cheap.
- Newsletter recipients are queried from the existing member index with `active` and `newsletterOptIn=true` filters, then consent is checked again immediately before delivery. A five-minute, token-owned `claimed` lease lets a worker crash safely before the provider attempt; an expired lease or explicit `retry_pending` reconciliation can be claimed again. Immediately before calling SES, the worker changes the record to `accepted_unconfirmed`, meaning a provider send attempt started and acceptance is unknown. That state has no automatic retry.
- Deletes are normally state transitions/soft archives so club history is not silently erased.

Project/team `memberIds` and `memberHandles` are denormalized internal management projections and are removed from unauthenticated DTOs. A handle change cascades to GSI-indexed live relationship/RSVP records and active resource projections; historical authored notification/newsletter snapshots are intentionally not rewritten. Relationship records and audit items remain the reconstructable source of membership history. The team maximum is capped at 100, keeping those arrays comfortably below DynamoDB item limits for the present club scale.

Legacy member items without `isPublicProfile` or `newsletterOptIn` normalize both to `false`. New member handles are random aliases and never derive from the school-email local part. `lastSeenAt` changes on authentication without changing the profile's `updatedAt`, and neither timestamp is returned by member-search or public-directory DTOs.

Preference history is included in the member's self-service export and retained indefinitely with the account. Because it lives in the member partition, self-service account deletion removes it; the separate nonpersonal hashed deletion-completion audit remains. For suspended accounts, a minimal identity restriction also remains to enforce the suspension. Other self-service deletion is intentionally best-effort and query-only: it deletes/unlinks records reachable through the member partition and sparse member indexes without a table scan, removes the entire member avatar prefix, and leaves pseudonymous audit/resource-owner references needed for club integrity. Newsletter delivery/reconciliation records remain with the club newsletter and can retain the pseudonymous member UUID. Legacy nonindexed RSVP and historical authored snapshot discovery requires officer assistance. There is no fixed TTL on member/resource records; the current retention choice is indefinite until explicit deletion or archive.

# DynamoDB data model

The backend uses one on-demand table with partition key `pk`, sort key `sk`, and two sparse GSIs. Application entities use provider-neutral UUIDs; Microsoft `oid` and Cognito `sub` values exist only in identity lookup/profile metadata.

## Item shapes

| Entity | `pk` | `sk` | Purpose |
|---|---|---|---|
| Member | `USER#<member UUID>` | `PROFILE` | Private profile, club role/status, provider metadata |
| Identity lookup | `IDENTITY#<provider>#<subject>` | `LOOKUP` | Maps Entra `oid` or Cognito `sub` to member UUID |
| Email lookup | `EMAIL#<sha256 normalized email>` | `LOOKUP` | Prevents duplicate accounts without exposing email in the key |
| Handle lookup | `HANDLE#<handle>` | `LOOKUP` | Reserves unique email-derived handle |
| Invitation inbox | `USER#<member UUID>` | `INVITE#<type>#<resource UUID>` | Pending project/team invitation summary |
| Notification | `USER#<member UUID>` | `NOTIFICATION#<13-digit time>-<UUID>` | Newest-first join-request inbox event and optional read timestamp |
| Project | `PROJECT#<UUID>` | `METADATA` | Content, publication state, owner, active-member projection |
| Project membership | `PROJECT#<UUID>` | `MEMBER#<member UUID>` | Owner/contributor role and membership state |
| Project membership audit | `PROJECT#<UUID>` | `AUDIT#<time>#<UUID>` | Append-only membership action |
| Team | `TEAM#<UUID>` | `METADATA` | Content, capacity, join policy, owner, active-member projection |
| Team membership | `TEAM#<UUID>` | `MEMBER#<member UUID>` | Owner/member role and membership state |
| Team membership audit | `TEAM#<UUID>` | `AUDIT#<time>#<UUID>` | Append-only membership action |
| Event | `EVENT#<UUID>` | `METADATA` | Time, place, publication/archive state, creator |
| RSVP | `EVENT#<UUID>` | `MEMBER#<member UUID>` | Going/maybe state and public handle |
| Newsletter | `NEWSLETTER#<idempotency UUID>` | `METADATA` | Officer-authored content, status, and delivery counters |
| Newsletter delivery | `NEWSLETTER#<UUID>` | `DELIVERY#<member UUID>` | Idempotency marker and sent/skipped outcome |

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
| All projects, including drafts/review/archive | `RESOURCES#PROJECTS` | `CREATED#<ISO time>#<UUID>` |
| All teams, including archived | `RESOURCES#TEAMS` | `CREATED#<ISO time>#<UUID>` |
| All events, including drafts/archive | `RESOURCES#EVENTS` | `START#<ISO time>#<UUID>` |
| Newsletter history | `NEWSLETTERS` | `CREATED#<ISO time>#<UUID>` |
| Unread notifications | `USER#<member UUID>` | `NOTIFICATION#<13-digit time>-<UUID>` |

The API performs key/index queries, never table scans. Cursors are opaque base64url encodings of DynamoDB `LastEvaluatedKey` values and must not be constructed by clients. Filtered relationship/management pages can contain fewer results than their requested limit while still returning a next cursor.

## Consistency and concurrency

- Member profile, identity, email, and handle reservations are created in one transaction.
- Project/team metadata and the creator's owner relationship are created together.
- Requests, invitations, direct additions, removals, ownership transfers, and audit records use transactions.
- Team capacity is checked in the same conditional transaction that changes membership.
- Resource `updatedAt` values prevent concurrent projection changes from overwriting each other.
- Archived resources reject stale additions/approvals.
- Invitations have a resource relationship plus a user-partition inbox item; accepting, declining, revoking, or direct-adding removes the inbox item.
- Join-request creation/restoration, withdrawal, and review write their recipient notification in the same transaction as membership state and audit history. A direct add of an existing requester also records approval.
- Notification sort keys begin with a fixed-width Unix millisecond timestamp, so a reverse user-partition query returns the inbox newest first. Unread items also occupy a sparse `gsi2` entry; marking one read sets `readAt` and removes that entry, while marking it unread restores the entry. This makes the common unread query direct and cheap.
- Newsletter recipients are queried from the existing member index; per-member delivery markers make ordinary SQS redelivery idempotent and counters expose progress.
- Deletes are normally state transitions/soft archives so club history is not silently erased.

Project/team `memberIds` and `memberHandles` are denormalized card/list projections. Relationship records and audit items remain the reconstructable source of membership history. The team maximum is capped at 100, keeping those arrays comfortably below DynamoDB item limits for the present club scale.

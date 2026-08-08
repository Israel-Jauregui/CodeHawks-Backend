# ClubWebsite Backend implementation specification

## Freshness and trust metadata

> **Read this section before relying on the specification.**

| Field | Snapshot value |
|---|---|
| Spec format | `1` |
| Created | `2026-08-08T12:17:24-04:00` (`America/New_York`, EDT) |
| Revised | `2026-08-08T14:18:11-04:00` (`America/New_York`, EDT) — added authorized project/team image uploads |
| Git branch | `main` |
| Git commit | **`NO HEAD — UNCOMMITTED SNAPSHOT`** |
| Git state at creation | The repository had no first commit and all implementation files were untracked |
| Source fingerprint | `ef9caffd66f70a687536821830339f626263289a139f1f151c92bd8cbddb1f9e` |
| Last verification | `npm run check` passed on `2026-08-08` with 47 tests; Terraform 1.15.8 validation passed |

There was no commit hash to record when this file was created. Do not invent one and do not describe this snapshot as committed. Until the first commit exists, the source fingerprint is the reliable comparison value.

From the repository root, reproduce the fingerprint with:

```bash
rg --files -g '!SPEC.md' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
```

Treat this specification as stale when any of the following is true:

1. The fingerprint differs and the implementation changes are not reflected here.
2. A later commit or pull request changed `src/`, `infrastructure/`, the API contract, authorization, or the DynamoDB model without updating this document.
3. `npm run check` contradicts a claim in this document.
4. Deployed AWS configuration differs from the Terraform and configuration described here.

Once the project has a real Git history, the agent making a material implementation change should update the created/revised date, replace the snapshot commit field with the commit being reviewed, recompute the fingerprint, and summarize the specification change in the commit or pull request. If metadata and code disagree, code, tests, and reviewed infrastructure plans take precedence.

## Product purpose and decisions

This repository contains the AWS-native backend for the CodeHawks / UNG App Development Club website. It replaces the direction of an unfinished Linux/PostgreSQL backend with a cost-conscious serverless design. The old backend was inspiration only; its implementation details and authentication model were not copied.

Current product decisions:

- Access is intentionally available to anyone who can authenticate with an exact verified `@ung.edu` identity. The backend does not require current enrollment, so faculty, staff, and alumni who retain access are eligible.
- The system should work with as little UNG IT involvement as possible. Externally owned Microsoft Entra authentication is preferred, with Cognito verified-email OTP as the no-IT fallback.
- New-member friction stays low. Profiles are created just in time, and tech stack completion is optional.
- Club authorization comes from DynamoDB, never from browser input or token role/group claims.
- DynamoDB on-demand, Lambda, API Gateway HTTP API, SQS, SES, S3, and CloudFront are used to avoid always-on servers.
- UNG Connect is the intended system for event attendance and participation tracking. Do not expand this backend into a second attendance, check-in, waitlist, or engagement-scoring system without an explicit product decision. Basic event and RSVP routes currently exist, but they are not intended to compete with UNG Connect.

## Current maturity

- Application code, unit/API tests, build scripts, documentation, and Terraform are present.
- The backend has **not** been deployed.
- No AWS account, credentials, Terraform state backend, reviewed plan, production domain, or final frontend origins have been supplied.
- The final production authentication choice between Entra and Cognito has not been made.
- The first President has not been bootstrapped.
- The repository has no first Git commit as of this specification snapshot.

Never deploy, apply Terraform, bootstrap a role, or mutate AWS merely because this specification exists. Confirm the AWS account, region, state backend, variables, plan, and user authorization first.

## Runtime architecture

```text
ClubWebsite-Frontend
        |
        +--> selected authentication provider
        |      +--> externally owned Entra apps, or
        |      +--> Cognito email OTP + SES
        |
        +--> API Gateway HTTP API JWT authorizer
                    |
                    +--> API Lambda (Node.js/TypeScript)
                    |      +--> DynamoDB single table
                    |      +--> SQS newsletter queue
                    |      +--> S3 avatar/project/team image presigned POSTs
                    |
                    +--> newsletter worker Lambda --> SES

Private S3 media origin --> CloudFront --> public media URLs
CloudWatch receives Lambda/API logs and alarms on the newsletter DLQ.
```

Production composition begins in `src/handler.ts`. `createApi` in `src/api.ts` contains the route boundary. `DynamoClubRepository` is the only production persistence implementation.

## Authentication and identity

Only one authentication provider is enabled per deployment.

### Entra mode

- Uses club-owned, multitenant SPA and API registrations.
- The frontend uses authorization code + PKCE and sends an API access token, not an ID token.
- API Gateway validates the configured issuer/audience.
- Lambda additionally checks the configured UNG tenant ID, API audience, immutable object ID, and exact `ung.edu` login domain.
- This avoids requiring a UNG-owned application registration, but UNG tenant consent or Conditional Access policy may still display “Need admin approval.” The application cannot bypass that policy.

### Cognito fallback

- Uses passwordless email OTP; never add password authentication.
- A Cognito pre-sign-up trigger restricts signup to the exact allowed email domain.
- New accounts confirm an activation code sent through SES, then use `EMAIL_OTP` for later login.
- API Gateway validates Cognito tokens, and Lambda rechecks verified email and domain claims.
- This proves control of a UNG mailbox, not current enrollment or institutional endorsement.

### Provider-neutral identity model

- A member receives an application UUID.
- Entra `oid` and Cognito `sub` values are private lookup metadata, not resource foreign keys.
- Email is an eligibility and uniqueness check, never the member primary key.
- Project, team, audit, notification, newsletter, and event records reference the member UUID.
- Switching providers for an existing population requires an explicit identity-linking migration. Do not silently create duplicate accounts.

## Roles and authorization

Club roles, from least to most specialized, are:

- `member`
- `reservation_designee`
- `treasurer`
- `vice_president`
- `president`

Permission matrix:

| Permission | Member | Reservation Designee | Treasurer | Vice President | President |
|---|---:|---:|---:|---:|---:|
| `events.manage` | No | Yes | No | Yes | Yes |
| `members.manage` | No | No | No | Yes | Yes |
| `newsletters.send` | No | Yes | Yes | Yes | Yes |
| `projects.manage` | No | No | Yes | Yes | Yes |
| `roles.manage` | No | No | No | No | Yes |
| `teams.manage` | No | No | Yes | Yes | Yes |
| `treasury.manage` | No | No | Yes | No | Yes |

Resource ownership is separate from club office. Any active member can own and manage their own project or team. An owner or a role with the corresponding global permission can review requests, invite/directly add/remove members, view membership audit history, and transfer resource ownership.

Important invariants:

- Never accept a role from the frontend or access token.
- Suspended users may read only `GET /v1/me`; all other protected operations are denied.
- A Vice President cannot modify a President account.
- A member cannot suspend their own account.
- Only a President can assign club roles.
- Ownership transfers only to an active member of the resource.
- An owner must transfer ownership before leaving or being removed.
- Team capacity is transactionally enforced on every admission path.
- Only officers with `projects.manage` can publish a project.

## Domain model

### Member

Private member data includes the identity provider/subject, optional tenant, email, application UUID, email-derived handle, display name, club role, active/suspended status, profile fields, and timestamps.

Public-safe profile output is produced only by `toPublicMember` and excludes email, provider metadata, status, and last-seen data.

Editable profile fields:

- `displayName`
- `bio`
- `avatarUrl`
- `major`
- `minors` (maximum 4)
- `techStack` (maximum 25 entries, each maximum 50 characters)
- `githubUrl`
- `linkedinUrl`

`techStack` is optional and public. New members receive `[]`; older records missing the attribute are normalized to `[]` at repository read boundaries. Profile updates remove case-insensitive duplicates while preserving the first spelling. Signup and login never require the field.

### Project

- Member-created with UUID, name, description, owner, optional repository/demo/image URLs, project tech stack, and member projections.
- Owners and project-managing officers can request a constrained project-owned image upload, then persist its CloudFront URL as `imageUrl`.
- Publication states: `draft`, `pending_review`, `published`, `archived`.
- Creator becomes owner and active contributor in the same transaction.
- Only published projects are publicly readable.
- Project membership is always requested unless the owner/officer invites or directly adds a member.

### Team

- Member-created with UUID, name, description, owner, category, capacity, member projections, status, and join policy.
- Categories: `hackathon`, `ctf`, `project`, `study_group`, `other`.
- Statuses: `open`, `closed`, `archived`.
- Join policies: `open`, `approval_required`.
- An open-policy team admits immediately if capacity is available. An approval-required team creates a join request.
- Owners and team-managing officers can request a constrained team-owned image upload, then persist its CloudFront URL as `imageUrl`.

### Resource membership

Shared project/team membership statuses:

- `invited`
- `requested`
- `active`
- `rejected`
- `removed`

Shared membership roles are `owner`, `contributor`, and `member`. Relationship records retain inactive states for safe retries and history. Membership actions also append audit entries.

### Notification

The current notification system is a pull-based, authenticated in-app inbox. It does not send browser push or notification email.

Implemented notification types:

- `resource_join_requested`
- `resource_join_withdrawn`
- `resource_join_approved`
- `resource_join_rejected`

Each item contains an ID, type, title, message, actor UUID/handle/display name, resource type/UUID/name, creation time, and optional `readAt`.

Behavior:

- A new or restored project request notifies the project owner.
- A new or restored approval-required team request notifies the team owner.
- Withdrawing a request notifies the owner so an earlier request does not appear current without context.
- Approval or rejection notifies the requester.
- Directly adding a member who has a pending request records an approval notification.
- Repeating an already-pending request returns `already-requested` and does not duplicate the notification.
- Open-policy team auto-joins are not join requests and currently produce no notification.
- Invitations remain a separate actionable inbox at `/v1/me/invitations`; they have not yet been unified with notifications.

Notification writes occur in the same DynamoDB transaction as membership state and audit changes. `actorId` on a request notification is the member UUID accepted by the existing review endpoint, enabling frontend approve/reject actions without another lookup.

### Events

The repository currently supports basic event draft/publish/archive CRUD, going/maybe RSVP state, and officer RSVP rosters. UNG Connect is the product-level authority for event participation. Do not add attendance history, QR check-in, waitlists, engagement scoring, or similar participation features here unless explicitly requested.

### Newsletter

- Only Reservation Designee, Treasurer, Vice President, and President can send.
- Audience is every active club account; the frontend never supplies recipient addresses.
- API persists an idempotent newsletter and queues SQS work, returning `202` before delivery.
- The worker fans out through SES and records per-member delivery idempotency markers.
- Statuses are `queued`, `sending`, `sent`, and `queue_failed`.
- Counters record recipients, processed, sent-to-SES, and skipped. “Sent” does not prove mailbox delivery.

### Media

- The API creates five-minute S3 presigned POSTs for member avatars and authorized project/team resource paths.
- Supported declared MIME types are JPEG, PNG, and WebP; maximum size is 5 MiB.
- S3 is private and CloudFront serves the resulting URL.
- Resource image keys are isolated under `projects/{projectId}/` and `teams/{teamId}/`; a caller must own the resource or hold its management permission before the API issues a presign.
- Missing resource images are represented by a frontend-owned default asset rather than a stored placeholder URL.
- The current pipeline does not inspect file contents, resize images, strip EXIF data, or moderate content.

## DynamoDB design

The system uses one on-demand table with `pk` and `sk`, plus sparse `gsi1` and `gsi2` indexes. Production code must use key reads, queries, conditional writes, and transactions; do not add table scans.

Primary item patterns:

| Entity | `pk` | `sk` |
|---|---|---|
| Member | `USER#<member UUID>` | `PROFILE` |
| Identity lookup | `IDENTITY#<provider>#<subject>` | `LOOKUP` |
| Email lookup | `EMAIL#<sha256 normalized email>` | `LOOKUP` |
| Handle lookup | `HANDLE#<handle>` | `LOOKUP` |
| Notification | `USER#<member UUID>` | `NOTIFICATION#<13-digit epoch ms>-<UUID>` |
| Invitation summary | `USER#<member UUID>` | `INVITE#<TYPE>#<resource UUID>` |
| Project/team | `<PROJECT|TEAM>#<UUID>` | `METADATA` |
| Resource membership | `<PROJECT|TEAM>#<UUID>` | `MEMBER#<member UUID>` |
| Membership audit | `<PROJECT|TEAM>#<UUID>` | `AUDIT#<time>#<UUID>` |
| Event | `EVENT#<UUID>` | `METADATA` |
| RSVP | `EVENT#<UUID>` | `MEMBER#<member UUID>` |
| Newsletter | `NEWSLETTER#<idempotency UUID>` | `METADATA` |
| Newsletter delivery | `NEWSLETTER#<UUID>` | `DELIVERY#<member UUID>` |

`gsi1` supports public discovery and member handle-prefix search:

- `MEMBERS`
- `PROJECTS#PUBLISHED`
- `TEAMS#ACTIVE`
- `EVENTS#PUBLISHED`

`gsi2` supports member dashboards, management queues, newsletter history, and unread notifications:

- Member relationships use `USER#<member UUID>` / `RESOURCE#<TYPE>#<resource UUID>`.
- Unread notifications use the same user partition with `NOTIFICATION#...` sort keys.
- Marking a notification read sets `readAt` and removes its sparse unread index attributes.
- Marking it unread restores those index attributes.
- Resource management partitions are `RESOURCES#PROJECTS`, `RESOURCES#TEAMS`, and `RESOURCES#EVENTS`.
- Newsletter history uses `NEWSLETTERS`.

Public project/team cards denormalize `memberIds` and `memberHandles`; public conversion removes private IDs. Relationship and audit records remain the reconstructable membership history. Team size is capped at 100 to keep projections below DynamoDB item limits.

## API contract summary

All protected routes require `Authorization: Bearer <access token>`. JSON successes use `{ "data": ... }`; paginated responses add `{ "meta": { "nextCursor": string | null } }`. Cursors are opaque. List limits are 1–100 with a default of 25.

Public reads:

- `GET /health`
- `GET /v1/projects`
- `GET /v1/projects/{id}`
- `GET /v1/teams`
- `GET /v1/teams/{id}`
- `GET /v1/events`
- `GET /v1/events/{id}`

Member/profile routes:

- `GET /v1/me`
- `PATCH /v1/me`
- `POST /v1/me/avatar-upload`
- `GET /v1/members?search=<handle-prefix>`
- `PATCH /v1/members/{memberId}` for authorized role/status administration
- `GET /v1/me/memberships`
- `GET /v1/me/invitations`

Notification routes:

- `GET /v1/me/notifications`
- `GET /v1/me/notifications?read=false` uses the sparse unread index
- `GET /v1/me/notifications?read=true`
- `PATCH /v1/me/notifications/{notificationId}` with `{ "read": true }` or `{ "read": false }`

Project and team resource routes support:

- create, protected manage-read, update, and soft archive
- owner/officer-authorized direct-to-S3 image upload initialization
- create/withdraw/review join requests
- list relationships by status
- invite and revoke invitation
- accept/decline own invitation
- direct-add, remove, and leave
- transactional ownership transfer
- membership audit history

Project routes use `/v1/projects/{id}/...`; team routes mirror them at `/v1/teams/{id}/...`. Refer to `docs/api.md` before changing exact paths or bodies.

Resource image routes are `POST /v1/projects/{id}/image-upload` and `POST /v1/teams/{id}/image-upload`. After the returned browser-to-S3 POST succeeds, the frontend patches `imageUrl` with the returned CloudFront `publicUrl`.

Management routes:

- `GET /v1/manage/projects`
- `GET /v1/manage/teams`
- `GET /v1/manage/events`

Event routes currently support create/manage/update/archive, RSVP upsert/delete, and officer roster reads.

Newsletter routes:

- `POST /v1/newsletters`
- `GET /v1/newsletters`
- `GET /v1/newsletters/{id}`
- `POST /v1/newsletters/{id}/retry`

Error meanings:

- `400`: validation, malformed JSON/cursor/limit, or invalid self-management
- `401`: normally rejected by the API Gateway JWT authorizer
- `403`: wrong/invalid school identity, suspended member, or insufficient permission
- `404`: missing route/resource or non-public resource requested publicly
- `409`: stale/duplicate business state, full team, closed/archive state, or conditional-write conflict
- `500`: unexpected error; internal detail is logged, not returned

## Infrastructure represented in Terraform

- One DynamoDB on-demand table with point-in-time recovery and deletion protection defaults.
- API Gateway HTTP API with explicit public routes and one authenticated `ANY /v1/{proxy+}` route.
- ARM64 API Lambda and newsletter worker Lambda.
- SQS newsletter queue, dead-letter queue, redrive policy, and DLQ CloudWatch alarm.
- SES configuration set with reputation metrics and bounce/complaint suppression.
- Optional Cognito user pool/client and trigger Lambda when Cognito mode is selected.
- Private S3 media bucket, CloudFront origin access control/distribution, browser upload CORS, security headers, and API write scope limited to avatar/project/team prefixes.
- Least-scope IAM roles/policies for the represented workloads.
- CloudWatch log groups with bounded retention.
- Optional monthly AWS Budget alert.

AWS-owned service encryption is used where practical to avoid a dedicated KMS key monthly charge. No custom API/media domain is configured because final DNS ownership is unknown.

## Local development and verification

Expected toolchain:

- Node.js 22.13+ or 24+
- npm
- Terraform 1.10+

Commands:

```bash
npm ci
npm run check
terraform -chdir=infrastructure init -backend=false
terraform -chdir=infrastructure validate
```

`npm run check` performs TypeScript checking, ESLint, Vitest, and production Lambda bundle builds. At this snapshot, all 10 test files and 47 tests pass.

There is intentionally no unsigned local authentication bypass. API tests construct the JWT-authorizer claim shape that API Gateway would provide.

After infrastructure edits, also run:

```bash
terraform -chdir=infrastructure fmt -recursive
terraform -chdir=infrastructure validate
```

## Known gaps and deliberate non-goals

- No AWS deployment or reviewed Terraform plan exists yet.
- No finalized Entra consent result or production Cognito choice exists.
- Club officer succession is not atomic: there is no term model, club-role audit ledger, single-President invariant, or one-call leadership transition workflow. Project/team ownership transfer is transactional and separate.
- Notifications cover join-request lifecycle only. There is no WebSocket, browser push, notification email, generalized activity feed, or stored unread counter. Invitations still use their existing separate inbox.
- Member directory lookup is handle-prefix only. Tech stack is visible but not indexed/searchable.
- No project task board, openings/roles, GitHub App, webhook synchronization, mentorship, or contribution portfolio exists.
- No finance ledger exists. `treasury.manage` is reserved for a future security/requirements pass.
- Do not build a second event participation system; UNG Connect fills that role.
- No image processing or content moderation exists.
- No guessed legacy database importer exists. Build migration tooling only from a real read-only export and agreed cutover plan.
- Newsletter deliverability still requires verified SES identity/DKIM and production sending access.
- Switching authentication providers after onboarding requires an audited identity-linking migration.

## Change rules for future agents

1. Read `AGENTS.md` completely before editing.
2. Recheck the freshness metadata and fingerprint above.
3. Treat `src/domain/entities.ts`, `src/domain/schemas.ts`, `src/auth/permissions.ts`, `src/repositories/club-repository.ts`, `src/repositories/dynamo-club-repository.ts`, and `src/api.ts` as one coordinated contract.
4. Preserve provider-neutral member UUIDs and public conversion boundaries.
5. Add permissions explicitly and update `docs/authorization.md`.
6. Prefer DynamoDB queries/transactions; do not introduce production scans.
7. Keep newsletters asynchronous and resolve recipients server-side.
8. Preserve soft archive and audit history.
9. Add or update tests and `docs/api.md` for contract changes.
10. Run `npm run check`; run Terraform formatting/validation when infrastructure changes.
11. Never commit secrets, tokens, Terraform state, plan files, real `terraform.tfvars`, or AWS credentials.
12. Never deploy or mutate AWS without confirming authority, account, region, state, variables, and reviewed plan.
13. Update this specification's date, commit/fingerprint metadata, relevant design sections, known gaps, and verification result after material changes.

## Source-of-truth map

| Concern | Primary source |
|---|---|
| Contributor/security invariants | `AGENTS.md`, `SECURITY.md` |
| Product and architecture overview | `README.md` |
| Domain/public response types | `src/domain/entities.ts` |
| Input constraints | `src/domain/schemas.ts` |
| Role permissions | `src/auth/permissions.ts`, `docs/authorization.md` |
| Identity claim validation | `src/auth/identity.ts`, `src/auth/cognito-trigger.ts` |
| Route behavior | `src/api.ts`, `docs/api.md` |
| Persistence contract | `src/repositories/club-repository.ts` |
| DynamoDB implementation | `src/repositories/dynamo-club-repository.ts` |
| DynamoDB access patterns | `docs/data-model.md` |
| Auth choice and frontend flows | `docs/authentication.md`, `docs/entra-setup.md`, `docs/frontend-integration.md` |
| Newsletter delivery | `src/email/`, `docs/email.md` |
| Media uploads | `src/media/s3-media-service.ts` |
| AWS resources and IAM | `infrastructure/` |
| Expected behavior | `test/` |

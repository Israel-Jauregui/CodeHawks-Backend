# API contract

Base path: `/v1`. Bodies are JSON except the direct browser-to-S3 upload. Protected routes require the access token from the selected provider in `Authorization: Bearer <token>`.

Successful JSON responses use `{ "data": ... }`. Paginated responses also contain `{ "meta": { "nextCursor": string | null } }`. Successful operations documented as no-content return `204` with an empty body.

List routes accept `limit=1..100` (default `25`) and the opaque `cursor` from the previous page.

## Public reads

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/health` | Service liveness; does not query DynamoDB |
| `GET` | `/v1/projects` | Published projects, newest first |
| `GET` | `/v1/projects/{id}` | One published project |
| `GET` | `/v1/teams` | Non-archived teams, newest first |
| `GET` | `/v1/teams/{id}` | One non-archived team |
| `GET` | `/v1/events` | Published events in start-time order |
| `GET` | `/v1/events/{id}` | One published event |

## Members and profiles

| Method | Route | Who | Behavior |
|---|---|---|---|
| `GET` | `/v1/me` | Authenticated user | Provision or return the private club profile |
| `PATCH` | `/v1/me` | Active member | Update profile fields |
| `POST` | `/v1/me/avatar-upload` | Active member | Create a five-minute constrained S3 presigned POST |
| `GET` | `/v1/me/notifications` | Active member | Newest-first notification inbox; optional `read=true` or `read=false` filter |
| `PATCH` | `/v1/me/notifications/{notificationId}` | Active member | Mark one own notification read or unread |
| `GET` | `/v1/me/invitations` | Active member | List pending project/team invitations |
| `GET` | `/v1/me/memberships` | Active member | List own resource relationships; optional `resourceType` and `status` filters |
| `GET` | `/v1/members?search=ada` | Active member | Prefix-search safe public profiles by handle |
| `PATCH` | `/v1/members/{memberId}` | VP/President for status; President for roles | Change role and/or active/suspended status |

Profile fields are `displayName`, `bio`, `avatarUrl`, `major`, `minors`, `techStack`, `githubUrl`, and `linkedinUrl`. Use `null` to remove an optional scalar. `techStack` is optional, accepts up to 25 entries of 50 characters each, and removes case-insensitive duplicates while retaining the first spelling. New accounts receive an empty stack; completing it never blocks signup or login. It is included in public-safe member directory responses so members can discover one another by experience and interests.

Example:

```json
{
  "displayName": "Ada Lovelace",
  "bio": "Building things with the club.",
  "major": "Computer Science",
  "minors": ["Cybersecurity"],
  "techStack": ["TypeScript", "React", "AWS"],
  "linkedinUrl": "https://www.linkedin.com/in/example"
}
```

### Notification inbox

Join-request notifications are persisted in DynamoDB as part of the same transaction as the membership change. Project/team owners receive `resource_join_requested` and `resource_join_withdrawn`; requesters receive `resource_join_approved` or `resource_join_rejected`. Directly adding a member who already has a pending request also produces an approval notification.

List all notifications with `GET /v1/me/notifications`, or request only unread messages with `GET /v1/me/notifications?read=false`. Mark an item read with `{"read":true}` or unread with `{"read":false}`.

```json
{
  "id": "1786204800000-8fb7b632-c058-4a33-b2c1-26689b23eaf9",
  "type": "resource_join_requested",
  "title": "New project join request",
  "message": "Ada Lovelace requested to join your project, Club Website.",
  "actorId": "11111111-1111-4111-8111-111111111111",
  "actorHandle": "ada",
  "actorDisplayName": "Ada Lovelace",
  "resourceType": "project",
  "resourceId": "22222222-2222-4222-8222-222222222222",
  "resourceName": "Club Website",
  "createdAt": "2026-08-08T16:00:00.000Z",
  "readAt": "2026-08-08T16:05:00.000Z"
}
```

`readAt` is omitted while unread. Notifications are structured so the frontend can deep-link using `resourceType` and `resourceId`; it should not parse the human-readable message to determine behavior. For `resource_join_requested`, `actorId` is the `{memberId}` accepted by the existing project/team join-request review route, allowing approve/reject actions directly from the inbox. This is currently an authenticated in-app inbox, not browser push or notification email.

Avatar upload flow:

1. Call `POST /v1/me/avatar-upload` with `{"contentType":"image/webp","fileSize":120000}`. Supported types are JPEG, PNG, and WebP; maximum size is 5 MiB.
2. Submit a browser `multipart/form-data` POST to the returned `uploadUrl`, including every returned `fields` entry unchanged and the file last.
3. Save the returned `publicUrl` with `PATCH /v1/me` as `avatarUrl`.

The S3 bucket is private; CloudFront serves an uploaded avatar once its URL is used. The current pipeline does not inspect image contents, strip metadata, or resize files.

## Projects

| Method | Route | Who | Behavior |
|---|---|---|---|
| `POST` | `/v1/projects` | Active member | Create draft or submit for review; creator becomes owner |
| `GET` | `/v1/projects/{id}/manage` | Owner or project-managing officer | Read full project, including non-public state and member IDs |
| `PATCH` | `/v1/projects/{id}` | Owner or project-managing officer | Edit; only an officer can publish |
| `POST` | `/v1/projects/{id}/image-upload` | Owner or project-managing officer | Create a five-minute constrained image presigned POST |
| `DELETE` | `/v1/projects/{id}` | Owner or project-managing officer | Soft archive |
| `POST` | `/v1/projects/{id}/join-requests` | Active member | Request contributor membership |
| `DELETE` | `/v1/projects/{id}/join-requests/me` | Requesting member | Withdraw own pending request |
| `PATCH` | `/v1/projects/{id}/join-requests/{memberId}` | Owner or project-managing officer | Accept or reject request |
| `GET` | `/v1/projects/{id}/memberships?status=requested` | Owner or project-managing officer | List memberships by status |
| `POST` | `/v1/projects/{id}/invitations` | Owner or project-managing officer | Invite an active member |
| `DELETE` | `/v1/projects/{id}/invitations/{memberId}` | Owner or project-managing officer | Revoke pending invitation |
| `PATCH` | `/v1/projects/{id}/invitation` | Invitee | Accept or decline own invitation |
| `POST` | `/v1/projects/{id}/members` | Owner or project-managing officer | Directly add an active member |
| `DELETE` | `/v1/projects/{id}/members/me` | Active project member | Leave after ownership is transferred if needed |
| `DELETE` | `/v1/projects/{id}/members/{memberId}` | Owner or project-managing officer | Remove an active member |
| `PATCH` | `/v1/projects/{id}/owner` | Owner or project-managing officer | Transfer ownership to an active project member |
| `GET` | `/v1/projects/{id}/membership-audit` | Owner or project-managing officer | Newest-first membership history |

Create example:

```json
{
  "name": "Club Website",
  "description": "The public club site and member workspace.",
  "repoUrl": "https://github.com/example/club-website",
  "techStack": ["React", "TypeScript", "AWS"],
  "submitForReview": true
}
```

New projects are `draft` or `pending_review`; only `published` projects are public. Membership statuses are `invited`, `requested`, `active`, `rejected`, and `removed`. Review bodies use `{"status":"active"}` or `{"status":"rejected"}`. Invite, direct-add, and ownership bodies use `{"memberId":"<member UUID>"}`. An invitee responds with `{"response":"accepted"}` or `{"response":"declined"}`.

To attach an uploaded project image, create the project first, call `POST /v1/projects/{id}/image-upload` with the same metadata body used by the avatar upload route, upload the file directly to S3 using the returned fields, then save `publicUrl` with `PATCH /v1/projects/{id}` as `imageUrl`. The caller must own the project or hold `projects.manage`.

Creating, withdrawing, approving, or rejecting a join request updates the relevant member inbox transactionally. Repeated requests that return `already-requested` do not create duplicate notifications.

## Teams

Team routes mirror project membership management:

| Method | Route | Who | Behavior |
|---|---|---|---|
| `POST` | `/v1/teams` | Active member | Create team and become owner |
| `GET` | `/v1/teams/{id}/manage` | Owner or team-managing officer | Read full team, including archived state and member IDs |
| `PATCH` | `/v1/teams/{id}` | Owner or team-managing officer | Edit, open, close, or archive |
| `POST` | `/v1/teams/{id}/image-upload` | Owner or team-managing officer | Create a five-minute constrained image presigned POST |
| `DELETE` | `/v1/teams/{id}` | Owner or team-managing officer | Soft archive |
| `POST` | `/v1/teams/{id}/join-requests` | Active member | Join immediately if open-policy; otherwise request |
| `DELETE` | `/v1/teams/{id}/join-requests/me` | Requesting member | Withdraw pending request |
| `PATCH` | `/v1/teams/{id}/join-requests/{memberId}` | Owner or team-managing officer | Accept/reject with capacity enforcement |
| `GET` | `/v1/teams/{id}/memberships?status=requested` | Owner or team-managing officer | List memberships by status |
| `POST` | `/v1/teams/{id}/invitations` | Owner or team-managing officer | Invite member |
| `DELETE` | `/v1/teams/{id}/invitations/{memberId}` | Owner or team-managing officer | Revoke invitation |
| `PATCH` | `/v1/teams/{id}/invitation` | Invitee | Accept/decline invitation |
| `POST` | `/v1/teams/{id}/members` | Owner or team-managing officer | Directly add member |
| `DELETE` | `/v1/teams/{id}/members/me` | Active team member | Leave |
| `DELETE` | `/v1/teams/{id}/members/{memberId}` | Owner or team-managing officer | Remove member |
| `PATCH` | `/v1/teams/{id}/owner` | Owner or team-managing officer | Transfer ownership to active team member |
| `GET` | `/v1/teams/{id}/membership-audit` | Owner or team-managing officer | Membership history |

Create example:

```json
{
  "name": "Spring CTF Team",
  "description": "Beginner-friendly competition team.",
  "category": "ctf",
  "joinPolicy": "approval_required",
  "maxMembers": 6
}
```

Categories are `hackathon`, `ctf`, `project`, `study_group`, and `other`. Capacity is enforced transactionally for approvals, invitation acceptance, direct addition, and open joining.

Team image uploads follow the project flow at `POST /v1/teams/{id}/image-upload`, followed by direct S3 upload and `PATCH /v1/teams/{id}` with the returned `publicUrl` as `imageUrl`. Supported files are JPEG, PNG, and WebP up to 5 MiB. Resource cards without an `imageUrl` use a frontend-owned default image; the backend does not store a placeholder URL.

## Events

| Method | Route | Who | Behavior |
|---|---|---|---|
| `POST` | `/v1/events` | Reservation Designee, VP, President | Create draft or published event |
| `GET` | `/v1/events/{id}/manage` | Reservation Designee, VP, President | Read draft, published, or archived event |
| `PATCH` | `/v1/events/{id}` | Reservation Designee, VP, President | Edit or publish |
| `DELETE` | `/v1/events/{id}` | Reservation Designee, VP, President | Soft archive |
| `PUT` | `/v1/events/{id}/rsvp` | Active member | Upsert `going` or `maybe` on a published event |
| `DELETE` | `/v1/events/{id}/rsvp` | Active member | Remove own RSVP from a published event |
| `GET` | `/v1/events/{id}/rsvps` | Reservation Designee, VP, President | Paginated RSVP roster |

Event timestamps must be ISO 8601 with an offset, and `endsAt` must be later than `startsAt`.

## Officer management queues

| Method | Route | Permission | Behavior |
|---|---|---|---|
| `GET` | `/v1/manage/projects?status=pending_review` | `projects.manage` | List all project states, optionally filtered |
| `GET` | `/v1/manage/teams?status=archived` | `teams.manage` | List all team states, optionally filtered |
| `GET` | `/v1/manage/events` | `events.manage` | List draft, published, and archived events |

Owners discover their own draft/active resources through `/v1/me/memberships`, then load the protected `/{id}/manage` route. Global officers use the management queues.

## Newsletters

Newsletter routes require `newsletters.send`, granted only to Reservation Designee, Treasurer, Vice President, and President.

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/v1/newsletters` | Persist and queue a newsletter; returns `202` before delivery |
| `GET` | `/v1/newsletters` | Paginated officer-only send history |
| `GET` | `/v1/newsletters/{id}` | Content, sender, status, and delivery counters |
| `POST` | `/v1/newsletters/{id}/retry` | Requeue a newsletter whose initial SQS operation failed |

Create example:

```json
{
  "idempotencyKey": "d119248b-220a-4c32-8423-98e71f4752bf",
  "subject": "CodeHawks weekly update",
  "body": "Meeting Thursday at 6 PM.\n\nProject demos begin at 6:30."
}
```

Generate the idempotency key once with `crypto.randomUUID()` and retain it while retrying the same compose action. Reusing it with different content returns `409`.

The audience is every active club account, including officers; suspended accounts are excluded. Email addresses are never accepted from the browser. The API stores plain text, the worker produces a plain-text part plus safely escaped HTML, and SQS handles delivery asynchronously. Statuses are `queued`, `sending`, `sent`, and `queue_failed`; `recipientCount`, `processedCount`, `sentCount`, and `skippedCount` support progress UI. Here, `sentCount` means SES accepted the send request, not that the destination mailbox ultimately delivered it.

See [email.md](email.md) for signup activation, SES prerequisites, retry behavior, and operational limitations.

## Errors

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request did not pass validation.",
    "details": [{ "path": ["name"], "message": "Too small" }],
    "requestId": "api-gateway-request-id"
  }
}
```

- `400`: malformed JSON, invalid field/cursor/limit, or invalid self-management action
- `401`: missing or invalid JWT, normally rejected by API Gateway
- `403`: wrong school identity, suspended account, or missing permission
- `404`: route/resource missing or non-public resource requested publicly
- `409`: stale membership/resource state, duplicate operation, archived/closed resource, or full team
- `500`: unexpected error; internal detail remains in CloudWatch

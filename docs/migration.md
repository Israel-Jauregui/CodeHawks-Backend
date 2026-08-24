# Linux/PostgreSQL migration notes

Treat the unfinished backend as a source of domain intent and recoverable club data only. Do not migrate its password system, temporary codes, sessions, server-specific behavior, or database IDs.

| Legacy data | New representation | Notes |
|---|---|---|
| member username | `Member.handle` | Validate against current handle rules, reserve uniquely, and set both consent flags to `false`; never derive a new handle from email |
| full name | `Member.displayName` | Seed from identity provider, then member-editable |
| email | `Member.email` | Link only after the selected provider verifies exact `@ung.edu` control |
| password hash / temp code / verified flag | Not migrated | Entra or Cognito email OTP replaces legacy auth |
| profile picture | S3/CloudFront URL in `avatarUrl` | Re-encode/review and upload to the member-owned media prefix; arbitrary external URLs are no longer accepted |
| bio / GitHub / LinkedIn | Member profile fields | Validate and normalize URLs |
| major / minor tables | `major` and `minors` | Small profile attributes stay on the member item |
| project row | Project metadata | Assign new UUID/owner and draft/review/published state |
| member-project join | Project membership | Map to member UUID; classify owner/contributor and state |
| team row | Team metadata | Assign category, owner, join policy, capacity, and status defaults |
| member-team join | Team membership | Import active relationships and recompute projections/count |
| event row | Event metadata | Convert to timezone-aware start/end timestamps and location |
| member-event join | RSVP | Import only if the old relationship truly represented an RSVP |

## Identity linking

Have users sign in before importing their private records. Match a legacy row to a newly verified identity by normalized school email in a dry run, then write relationships using the new member UUID. Never treat an email match from an unverified legacy row as sufficient evidence by itself.

If the authentication provider later changes, add the new provider identity lookup to the existing member UUID through a purpose-built audited operator tool. Do not allow a normal sign-in to auto-merge identities merely because the email text matches.

## Recommended cutover

1. Export the old database read-only to JSON/CSV and inventory uploaded assets.
2. Produce a dry-run report: totals, invalid emails/URLs, duplicate handles, orphan joins, missing owners, and ambiguous event times.
3. Select and validate the production authentication mode; have users sign in so member UUIDs exist.
4. Import into a staging table, rebuild member arrays/counts from relationships, and compare totals/access patterns.
5. Freeze old writes, take a final export, rerun the idempotent importer, verify, and switch the frontend API URL.
6. Retain a protected snapshot for an agreed rollback period and permanently disable old login endpoints.

Build the importer only after seeing the real export. It should support `--dry-run`, idempotency keys, a rejected-row report, and explicit target AWS account/table confirmation.

# Security policy

Report suspected vulnerabilities privately to the current club President or faculty advisor. Never open a public issue containing tokens, account IDs, personal information, exploit detail, or credentials.

Security invariants:

- API Gateway validates JWT signature, selected issuer, audience, and lifetime; Entra routes also require the delegated API scope.
- Lambda rechecks provider-specific claims, exact `@ung.edu` eligibility, and verified email in Cognito mode.
- Entra mode pins the exact UNG tenant. Cognito mode proves mailbox control and must not be represented as institutional approval.
- Provider subjects map to a private member UUID. Email is not the primary key.
- Roles and suspension state come only from DynamoDB, never browser input or token roles/groups.
- Public directory output exists only for active explicit opt-ins and excludes email, internal/provider IDs, role/status, consent flags, and timestamps. Authenticated invitation search returns only member UUID, handle, and display name and requires at least a three-character prefix.
- Resource owners and officer permissions are enforced before membership-management reads/writes.
- DynamoDB permissions are limited to one table/index set. Media object access is limited to the represented pending/final prefixes in the backend bucket, and bucket listing is separately constrained to final and pending avatar prefixes for account deletion.
- The media bucket blocks public S3 access. CloudFront origin access excludes `pending/` and avatar caching is disabled. Presigned POSTs constrain owner-scoped pending prefixes, declared MIME type, size, and expiration; abandoned pending objects expire after one day. Finalization reads ETag-pinned bytes, verifies scope/size/type/magic bytes, and uses a create-only final write so presign reuse cannot overwrite an immutable URL. Invalid objects are deleted.
- Team admission and membership projection changes use conditional transactions.
- Only four officer roles receive `newsletters.send`; recipient addresses are resolved server-side from active explicit opt-ins, consent is rechecked before delivery, and addresses are never accepted from browser input.
- Newsletter content is authored as plain text and escaped before HTML rendering. SQS carries UUIDs rather than email content or addresses.
- SES uses a verified identity and a configuration set that suppresses bounce/complaint destinations; failed jobs are retained in a dead-letter queue.
- State, tfvars, tokens, and credentials are ignored and must never be committed.
- DynamoDB PITR, deletion protection, audit entries, and soft archival protect production data/history.

Known production follow-ups:

- add image decoding/transcoding to reject malformed pixel data, strip EXIF, and generate bounded variants; current quarantine validates metadata and magic bytes but does not fully decode or moderate images;
- add dependency, secret, and Terraform scanning in CI;
- configure operational/security alarms and test backup restoration;
- obtain organizational/legal contact details for the privacy notice and confirm officer offboarding and incident-response ownership; current profile/newsletter choices are private-by-default and current retention is indefinite until deletion/archive;
- test Entra Conditional Access/consent with a normal non-admin `@ung.edu` user or complete the Cognito/SES fallback;
- add abuse/rate controls around account creation and OTP delivery appropriate to observed traffic.
- define operator reconciliation for ambiguous SES timeouts and post-SES delivery-claim completion failures.

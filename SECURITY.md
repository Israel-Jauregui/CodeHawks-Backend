# Security policy

Report suspected vulnerabilities privately to the current club President or faculty advisor. Never open a public issue containing tokens, account IDs, personal information, exploit detail, or credentials.

Security invariants:

- API Gateway validates JWT signature, selected issuer, audience, and lifetime; Entra routes also require the delegated API scope.
- Lambda rechecks provider-specific claims, exact `@ung.edu` eligibility, and verified email in Cognito mode.
- Entra mode pins the exact UNG tenant. Cognito mode proves mailbox control and must not be represented as institutional approval.
- Provider subjects map to a private member UUID. Email is not the primary key.
- Roles and suspension state come only from DynamoDB, never browser input or token roles/groups.
- Public member output excludes email, provider/subject, status, and last-seen metadata.
- Resource owners and officer permissions are enforced before membership-management reads/writes.
- DynamoDB permissions are limited to one table/index set; media writes are limited to `avatars/*`.
- The media bucket blocks public S3 access. CloudFront reads through origin access control; presigned POSTs constrain prefix, declared MIME type, size, and expiration.
- Team admission and membership projection changes use conditional transactions.
- Only four officer roles receive `newsletters.send`; recipient addresses are resolved server-side from active profiles and never accepted from browser input.
- Newsletter content is authored as plain text and escaped before HTML rendering. SQS carries UUIDs rather than email content or addresses.
- SES uses a verified identity and a configuration set that suppresses bounce/complaint destinations; failed jobs are retained in a dead-letter queue.
- State, tfvars, tokens, and credentials are ignored and must never be committed.
- DynamoDB PITR, deletion protection, audit entries, and soft archival protect production data/history.

Known production follow-ups:

- add image decoding/transcoding to reject spoofed content, strip EXIF, and generate size-limited variants;
- add dependency, secret, and Terraform scanning in CI;
- configure operational/security alarms and test backup restoration;
- confirm data retention, profile visibility, privacy notice, officer offboarding, and incident-response ownership;
- test Entra Conditional Access/consent with a normal non-admin `@ung.edu` user or complete the Cognito/SES fallback;
- add abuse/rate controls around account creation and OTP delivery appropriate to observed traffic.
- define the club-newsletter consent/unsubscribe and retention policy before sustained production sending.

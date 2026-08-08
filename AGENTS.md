# Backend contributor notes

- Run `npm run check` after application changes.
- Run `terraform -chdir=infrastructure fmt -recursive` and `terraform -chdir=infrastructure validate` after infrastructure changes.
- Never add password authentication. Use an externally owned multitenant Entra app first and Cognito verified-email OTP only when UNG blocks external-app consent.
- Keep provider subjects behind identity lookup items and use provider-neutral member UUIDs. Email is an eligibility/profile check, never the member primary key.
- Never trust a role from the client or access token. Club roles come from the member item in DynamoDB.
- Public member responses must go through `toPublicMember`; do not expose email, tenant/object IDs, status, or last-seen data.
- Prefer DynamoDB `Query`, `GetItem`, conditional writes, and transactions. Do not add production table scans.
- Add new permissions explicitly in `src/auth/permissions.ts` and document the role matrix.
- Keep bulk email asynchronous. Never accept recipient addresses from the browser or send a club-wide message inside the API request Lambda.
- Treat Cognito activation/OTP email as transactional and newsletters as a separate audited stream with SES reputation and failure handling.
- Use soft archival for club resources. Preserve auditability.
- Do not deploy or mutate AWS unless the requested account, region, state backend, and plan have been explicitly confirmed.

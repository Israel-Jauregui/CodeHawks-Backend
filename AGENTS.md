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

## Secure infrastructure deployment

- Developer machines and agents must not run `terraform apply`, `terraform destroy`, or mutating AWS CLI commands. Do not run a local Terraform plan as a substitute for the protected GitHub plan.
- Before any AWS bootstrap, Terraform plan, or apply, explicitly confirm the AWS account ID, region, SES domain, authentication provider and its configuration, exact frontend origins, Terraform state bucket, and the Terraform plan being approved. Stop when any value is missing or ambiguous.
- Bootstrap the state bucket and GitHub OIDC roles only through the manual, administrator-owned CloudFormation procedure in `infrastructure/README.md`. Bootstrap template and trust changes remain manual AWS-admin operations.
- After bootstrap, configure branch/environment protections with `infrastructure/scripts/configure-github.sh` and deployment values with `infrastructure/scripts/configure-backend-deployment.sh`; both helpers are GitHub-only and must not mutate AWS.
- Run plans and applies only from protected `main` with the manual **Plan or apply backend infrastructure** GitHub workflow. Review a plan first, then use `operation=plan-and-apply` to create a fresh plan and approve the owner-gated `backend-infrastructure-production` environment only after that plan is explicitly confirmed.
- GitHub must use short-lived OIDC sessions and separate plan/apply roles. The routine apply role must never be allowed to modify its own role, trust policy, or permissions boundary. Terraform-created runtime roles must remain behind the separate runtime permissions boundary and must not receive IAM-administration access.
- Every Terraform resource or data source change must include a lifecycle IAM audit of both bootstrap roles: plan needs every refresh/read action, and apply needs create, read, update, tag, untag, and delete actions. Isolate actions that do not support resource-level permissions in dedicated statements, constrain them with supported condition keys, and document unavoidable wildcard resources in `infrastructure/bootstrap/PERMISSIONS.md`.
- Reject plans with an unexpected account, region, state target, auth mode, SES identity, CORS origin, replacement, or deletion. Never apply automatically from a push or pull request, and never silently re-plan after approval; apply only the reviewed, digest-verified plan bundle.

## SES and DNS State Ownership

- Backend Terraform owns the regional `aws_sesv2_email_identity` for `codehawks.org`, its SES configuration set, and the IAM references to that identity. Do not create or verify the SES identity manually and do not put Cloudflare credentials in this repository.
- The separate `CodeHawks-FrontEnd` Terraform state owns all Cloudflare DNS, including the three SES Easy DKIM CNAMEs. It accepts the backend output through its `SES_DKIM_TOKENS` GitHub environment variable.
- The required first-deployment order is: update/create the backend bootstrap permissions; apply the backend identity; copy `ses_dkim_tokens_json` into the frontend `infrastructure-production` variable `SES_DKIM_TOKENS`; apply frontend/domain infrastructure; wait for SES identity and DKIM status to become successful; then have the human owner request SES production access in the same region.
- SES production-access approval is an AWS account operation, not Terraform state. Agents may document or read its status but must not submit that request or mutate AWS from a local session.

# CodeHawks backend AWS infrastructure

Terraform provisions:

- one on-demand DynamoDB table with two sparse GSIs, TTL, AWS-owned encryption, PITR, and deletion protection
- one ARM64 Node.js 22 API Lambda with least-privilege DynamoDB/log/media-write IAM
- one API Gateway HTTP API with exact-origin CORS, public reads, JWT authorization for protected `/v1/*`, access logs, and throttling
- one private S3 media bucket and CloudFront distribution with origin access control
- one encrypted SQS newsletter queue, dead-letter queue, batch-one worker Lambda, SES domain identity with Easy DKIM, and configuration set with bounce/complaint suppression
- in `entra` mode: an authorizer pinned to the UNG issuer and our external multitenant API audience/scope
- in `cognito` mode: an Essentials passwordless email-OTP user pool/client and a small domain/token-claims Lambda; email delivery uses the supplied SES identity
- optional AWS Budget email notification

The auth modes are alternatives. Resources specific to Cognito use `count = 0` in Entra mode.

The newsletter event source passes one queued job to each worker invocation. The
worker does not reserve Lambda concurrency because low-quota AWS accounts cannot
reserve capacity while preserving AWS's required unreserved pool. Request a
regional concurrency quota increase before adding a reservation.

There are no long-lived AWS access keys in GitHub. GitHub Actions obtains short-lived OIDC sessions from separate plan and apply roles. The plan role can read infrastructure and hold only the Terraform state lock. The apply role is owner-gated and can manage the backend resources, but cannot edit its own role, trust policy, or permissions boundary. Terraform-created Lambda roles receive a separate runtime boundary that excludes IAM administration.

## AWS mutation policy

Developer machines and agents do not run `terraform apply`, `terraform destroy`, or mutating AWS CLI commands. Ongoing infrastructure changes use the manual GitHub workflow and the protected apply environment. The one unavoidable trust bootstrap is created manually in CloudFormation by the AWS account administrator.

## 1. Prepare the cross-state deployment

Before provisioning AWS resources:

1. Decide between Entra and Cognito using [`../docs/authentication.md`](../docs/authentication.md). For Entra, complete the ordinary-user consent probe and create the external API registration.
2. Confirm that the frontend repository's Terraform state still owns the `codehawks.org` Cloudflare zone. Backend Terraform creates the SES identity; frontend Terraform publishes the returned DKIM CNAMEs.
3. Confirm the exact AWS account ID, region, SES domain, frontend HTTPS origins, auth mode, and email addresses. Do not proceed if any target is ambiguous.

## 2. Bootstrap state and GitHub OIDC

GitHub cannot assume an AWS role until AWS trusts GitHub, so the first action is deliberately human-owned:

1. Sign in to the intended AWS account as the administrative setup identity and verify the account ID in the AWS console.
2. Open **CloudFormation → Create stack → With new resources** in the intended region.
3. Upload [`bootstrap/template.yaml`](bootstrap/template.yaml), name the stack `codehawks-backend-bootstrap`, and acknowledge named IAM resources.
4. Keep `CreateGitHubOidcProvider` set to `false` when the frontend bootstrap already created `token.actions.githubusercontent.com` in this AWS account. Set it to `true` only when the provider does not exist.
5. Confirm the immutable repository defaults are `Israel-Jauregui@29392107/CodeHawks-Backend@1328057941` and create the stack.
6. Copy all stack outputs. They identify the account, region, state bucket, plan role, apply role, and runtime permissions boundary.

The state bucket is private, encrypted, versioned, TLS-only, and retained if the stack is deleted. Bootstrap template updates remain manual AWS-admin changes. This intentional separation prevents a compromised routine apply workflow from granting itself more AWS access.

## 3. Protect the GitHub gates

After the first **Verify application and infrastructure** check appears on `main`, run this GitHub-only helper from the repository root:

```sh
./infrastructure/scripts/configure-github.sh
```

It protects `main`, makes workflow tokens read-only, restricts both AWS environments to `main`, and requires `Israel-Jauregui` to approve `backend-infrastructure-production`. It does not access or change AWS. The plan environment is not reviewer-gated because its AWS role cannot mutate infrastructure; the apply environment is the hard production gate.

## 4. Add deployment configuration

Export the CloudFormation outputs and the reviewed application configuration, then run the second GitHub-only helper:

```sh
AWS_ACCOUNT_ID="123456789012" \
AWS_REGION="us-east-1" \
AWS_PLAN_ROLE_ARN="arn:aws:iam::123456789012:role/codehawks-backend-terraform-plan" \
AWS_APPLY_ROLE_ARN="arn:aws:iam::123456789012:role/codehawks-backend-terraform-apply" \
TF_STATE_BUCKET="codehawks-backend-terraform-state-123456789012" \
RUNTIME_PERMISSIONS_BOUNDARY_ARN="arn:aws:iam::123456789012:policy/codehawks-backend-runtime-boundary" \
AUTH_PROVIDER="entra" \
ENTRA_API_CLIENT_ID="00000000-0000-0000-0000-000000000000" \
SES_DOMAIN="codehawks.org" \
EMAIL_FROM_ADDRESS="CodeHawks <noreply@codehawks.org>" \
EMAIL_REPLY_TO_ADDRESS="officers@codehawks.org" \
ALLOWED_ORIGINS='["https://codehawks.org","https://www.codehawks.org"]' \
./infrastructure/scripts/configure-backend-deployment.sh
```

For Cognito, set `AUTH_PROVIDER=cognito` and omit `ENTRA_API_CLIENT_ID`. To create an AWS Budget notification, also set `BUDGET_NOTIFICATION_EMAIL`; the helper stores it as a GitHub environment secret and Terraform marks it sensitive.

The former `SES_IDENTITY_ARN` GitHub variable is no longer consumed because this Terraform state now owns the identity. Remove that obsolete variable after `SES_DOMAIN` is configured to avoid misleading future operators.

## 5. Create and review the first plan

From the GitHub Actions page, run **Plan or apply backend infrastructure** from protected `main` with `operation=plan`. The workflow:

1. builds the exact Lambda packages from that commit;
2. validates the account, role ARNs, region, origins, Terraform, and remote state target;
3. assumes the read-only plan role with a short-lived OIDC token;
4. writes `backend/production.tfstate` in the bootstrap bucket;
5. posts the redacted Terraform plan to the run summary and preserves the exact binary plan privately in the bootstrap state bucket for up to two days.

Review the account/region, auth mode, SES identity, CORS origins, Cognito tier when applicable, CloudFront distribution, deletion protection, queue/DLQ, IAM roles, and budget. A plan must not contain unexpected replacement or deletion actions.

## 6. Apply a newly reviewed plan

Rerun the same workflow with `operation=plan-and-apply`. It creates a fresh plan first. Review that plan in the job summary, then approve the waiting `backend-infrastructure-production` environment. The apply job downloads the private plan bundle from the state bucket, verifies its SHA-256 digest, and applies that exact plan; it cannot silently re-plan after approval. Successful applies delete their bundle immediately, while abandoned plan-only bundles expire automatically.

Reject the environment deployment if the plan is wrong. No AWS apply runs automatically on a push or pull request.

After the first successful apply, copy the exact JSON array under **SES DNS handoff** in the run summary into the frontend repository's `infrastructure-production` GitHub environment variable named `SES_DKIM_TOKENS`. It is the raw `ses_dkim_tokens_json` output, without Terraform's display escaping. Run and approve the frontend **Apply infrastructure** workflow; its domain-owning Terraform state creates the three unproxied Cloudflare CNAMEs. Wait for SES identity verification and DKIM status to become successful, then have the human owner request SES production access in this same AWS region. Do not create the SES identity or DNS records manually.

Then copy `api_url`, the selected authentication outputs, and `media_public_base_url` into the frontend integration. Sign in once as the intended first President, then use the one-time role command in [`../docs/bootstrap.md`](../docs/bootstrap.md).

## Local validation

From the repository root:

```bash
npm ci
npm run check
cp infrastructure/terraform.tfvars.example infrastructure/terraform.tfvars
terraform -chdir=infrastructure init -backend=false
terraform -chdir=infrastructure validate
terraform -chdir=infrastructure plan -out=backend.tfplan
```

The final local `plan` requires AWS credentials and explicit backend configuration, so it is shown only for completeness. The committed `backend.tf` contains no account or bucket; protected GitHub jobs inject those values. Do not apply from a developer machine.

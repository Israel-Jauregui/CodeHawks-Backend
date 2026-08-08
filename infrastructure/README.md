# Infrastructure

Terraform provisions:

- one on-demand DynamoDB table with two sparse GSIs, TTL, AWS-owned encryption, PITR, and deletion protection
- one ARM64 Node.js 22 API Lambda with least-privilege DynamoDB/log/media-write IAM
- one API Gateway HTTP API with exact-origin CORS, public reads, JWT authorization for protected `/v1/*`, access logs, and throttling
- one private S3 media bucket and CloudFront distribution with origin access control
- one encrypted SQS newsletter queue, dead-letter queue, single-concurrency worker Lambda, and SES configuration set with bounce/complaint suppression
- in `entra` mode: an authorizer pinned to the UNG issuer and our external multitenant API audience/scope
- in `cognito` mode: an Essentials passwordless email-OTP user pool/client and a small domain/token-claims Lambda; email delivery uses the supplied SES identity
- optional AWS Budget email notification

The auth modes are alternatives. Resources specific to Cognito use `count = 0` in Entra mode.

From the repository root:

```bash
npm ci
npm run check
cp infrastructure/terraform.tfvars.example infrastructure/terraform.tfvars
terraform -chdir=infrastructure init
terraform -chdir=infrastructure validate
terraform -chdir=infrastructure plan -out=backend.tfplan
```

The active configuration deliberately has no remote state backend. Create `backend.tf` from `backend.tf.example` only after the state bucket/key and target AWS account are confirmed.

Before any plan, verify the SES identity in the same region and obtain production sending access; newsletters need SES in both auth modes. Before an Entra plan, complete the ordinary-user consent probe. In either mode, review the account, region, Cognito tier, CloudFront distribution, SQS/DLQ, deletion protection, CORS origins, and optional budget in the saved plan.

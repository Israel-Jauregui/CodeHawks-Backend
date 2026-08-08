# Bootstrap and deployment checklist

## Values still needed

- intended AWS account ID and region
- remote Terraform state bucket/key
- exact development and production frontend origins
- verified SES identity/From address, DKIM DNS records, and SES production access
- auth decision from [authentication.md](authentication.md)
- in Entra mode: our multitenant API client ID, SPA client ID, and redirect URIs
- in Cognito mode: completed activation-code and passwordless-login frontend screens
- optional budget notification address
- future custom hostnames, if any

## First President

The API never auto-promotes an email address or trusts an environment variable. After deployment:

1. The intended President signs in and calls `GET /v1/me`, creating a normal Member profile.
2. Copy the provider-neutral UUID in the response's `id` field.
3. From an operator session scoped to the backend table, run:

```bash
npm run bootstrap:role -- \
  --table codehawks-production \
  --member-id 00000000-0000-4000-8000-000000000000 \
  --role president
```

4. Have the President call `GET /v1/me` again and confirm `role` is `president`.
5. Use `PATCH /v1/members/{memberId}` for subsequent officer assignments.

Record the first promotion in the club's change log. The command uses the normal AWS credential chain; never pass keys on the command line.

## Terraform safety

- Verify `aws sts get-caller-identity` before every plan/apply.
- Keep production state remote and encrypted.
- Review a saved plan before apply.
- DynamoDB and Cognito deletion protection follow `enable_deletion_protection`; PITR protects DynamoDB.
- Confirm Cognito/SES region compatibility before choosing fallback mode.
- Confirm the newsletter dead-letter alarm and SES reputation metrics are visible to operators.
- Do not weaken protection merely to make a destroy command convenient.

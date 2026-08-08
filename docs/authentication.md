# Authentication strategy

The backend supports two mutually exclusive deployment modes. This lets the club try the best user experience without making the entire project depend on cooperation from UNG IT.

## Decision

Start with the Entra consent probe in [entra-setup.md](entra-setup.md).

- If an ordinary non-admin `@ung.edu` user can consent and receive an API access token, deploy `auth_provider = "entra"`.
- If Microsoft displays **Need admin approval**, deploy `auth_provider = "cognito"`. There is no legitimate application-side bypass for a tenant consent policy.

Do this before real accounts are created. Only one JWT issuer is configured on API Gateway at a time, and the same verified school email cannot silently create a second account through another provider.

Eligibility is intentionally any verified exact `@ung.edu` account. That includes students, faculty, staff, and alumni who retain the address; the backend does not attempt to infer current enrollment or affiliation from the suffix.

## Preferred: external Microsoft Entra app

The club owns two multitenant app registrations in a Microsoft tenant it controls: a browser SPA and an API. UNG does not need to own either registration. The login request goes directly to the known UNG tenant, while API Gateway accepts only the UNG issuer and our API audience.

The backend additionally checks:

- token audience is our API client ID;
- tenant ID is the configured UNG tenant;
- immutable Microsoft object ID exists;
- the token login name has the exact `ung.edu` domain.

This mode gives true Microsoft school-account SSO. It still depends on UNG's user-consent and Conditional Access policies. If those policies require an administrator, the club cannot override them.

## Fallback: Cognito email OTP

Terraform can instead create an Amazon Cognito Essentials user pool configured for passwordless email OTP. A pre-sign-up Lambda rejects every domain except exact `ung.edu`, Cognito verifies the mailbox, and a pre-token Lambda places the verified email in the access token. API Gateway then validates Cognito's signature, issuer, audience, and expiration; Lambda rechecks the exact domain and verified-email claim.

This requires no UNG app registration or API access. It proves control of an `@ung.edu` inbox, not institutional approval. It does require:

- an SES sending identity owned by the club, such as `codehawks.org`;
- SES production sending access in the deployment region;
- a verified From address supplied to Terraform.

No password, OTP, refresh token, or access token is stored in DynamoDB.

At signup, Cognito keeps the account unconfirmed and sends the branded CodeHawks activation code through SES. The frontend calls `ConfirmSignUp`; future passwordless logins use `EMAIL_OTP`. Entra accounts skip this extra message because Microsoft has already authenticated the account. See [email.md](email.md).

## Provider-neutral member records

Authentication identities are lookup records, not application primary keys:

```text
IDENTITY#entra#<oid>       -> member UUID
IDENTITY#cognito#<sub>     -> member UUID
EMAIL#<sha256>             -> member UUID
USER#<member UUID>/PROFILE -> role and profile
```

Projects, teams, events, invitations, and roles reference only the member UUID. This makes a later provider migration possible, but linking old and new identities must be an explicit, audited operator migration after both identities are verified.

## Security boundaries

- A token proves identity; it never grants an officer role.
- Club roles and suspension status come only from DynamoDB.
- The frontend never sends or chooses its role.
- Public member responses omit email and provider identifiers.
- Cognito and Entra are alternatives, not an account-enumerating fallback chain.

Official references:

- [Microsoft consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience)
- [Microsoft multitenant application conversion](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant)
- [Cognito passwordless authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html)
- [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)

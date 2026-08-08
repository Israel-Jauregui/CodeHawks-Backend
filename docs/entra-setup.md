# Microsoft Entra setup and consent probe

This design does **not** require UNG to create or host our app registrations. Create the registrations in a Microsoft Entra tenant controlled by the club or project owner, mark them multitenant, and test whether UNG permits ordinary user consent.

Microsoft's public OpenID metadata currently identifies the `ung.edu` tenant as:

```text
b8e6c58e-d6fa-4f4a-968c-d4be658dfe8e
```

That identifier is public, not a credential. Reconfirm the discovery metadata before production rather than treating this repository as the permanent authority.

## 1. API registration in our tenant

1. Register an app such as `CodeHawks API` in a tenant we control.
2. Set **Supported account types** to accounts in any organizational directory (multitenant).
3. Under **Expose an API**, set an Application ID URI and create delegated scope `access_as_user`.
4. Configure the scope so users may consent if the portal/policy offers that choice.
5. Record the API Application (client) ID. No API client secret is needed for JWT validation.

## 2. SPA registration in our tenant

1. Register `CodeHawks Web` as a multitenant app.
2. Add only exact development and production URLs as **Single-page application** redirect URIs.
3. Add delegated permission to the `access_as_user` scope exposed by `CodeHawks API`.
4. Record the SPA client ID. Never create or put a client secret in the browser.

The frontend uses authorization code with PKCE through MSAL and requests an access token for the API scope. It sends the **access token**, never an ID token, as `Authorization: Bearer <token>`.

## 3. Probe with a normal non-admin account

Before deploying around Entra:

1. Configure a minimal local SPA/MSAL login using the tenant-specific authority `https://login.microsoftonline.com/b8e6c58e-d6fa-4f4a-968c-d4be658dfe8e`.
2. Sign in in a private browser window with an ordinary `@ung.edu` account that has no administrative role.
3. Request `api://<API client ID>/access_as_user` and confirm an access token is returned.
4. Decode the token locally for inspection and confirm `tid`, `aud`, `oid`, and `scp`; do not paste a real token into an online decoder.

If the flow shows **Need admin approval**, stop. That is UNG policy, not a backend bug, and it cannot be bypassed by changing Lambda code. Select the Cognito email-OTP mode in [authentication.md](authentication.md).

## 4. Backend values

For a successful probe:

```hcl
auth_provider         = "entra"
entra_tenant_id       = "b8e6c58e-d6fa-4f4a-968c-d4be658dfe8e"
entra_api_client_id   = "<our multitenant API client ID>"
entra_required_scope  = "access_as_user"
```

API Gateway validates signature, exact UNG issuer, audience, lifetime, and scope. Lambda independently requires the configured tenant, immutable `oid`, and exact `@ung.edu` login name before provisioning a member UUID.

The domain policy intentionally permits students, faculty, staff, and alumni who can still authenticate with an exact `@ung.edu` identity. External guests whose sign-in identity uses another domain remain excluded.

Official references:

- [Microsoft single- and multitenant apps](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps)
- [Microsoft consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience)
- [Microsoft claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)

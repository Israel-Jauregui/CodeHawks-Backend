# Frontend integration

Keep the existing mock-data provider available while wiring the API. The deployed `auth_provider` Terraform output determines which login adapter the frontend must build; the backend never accepts both issuers simultaneously.

Shared values:

```dotenv
VITE_CLUB_DATA_SOURCE=api
VITE_API_BASE_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com
VITE_AUTH_PROVIDER=entra
```

## Entra adapter

```dotenv
VITE_ENTRA_TENANT_ID=b8e6c58e-d6fa-4f4a-968c-d4be658dfe8e
VITE_ENTRA_SPA_CLIENT_ID=<our multitenant SPA client ID>
VITE_ENTRA_API_SCOPE=api://<our API client ID>/access_as_user
```

1. Configure MSAL Browser/React with the tenant-specific UNG authority and the SPA redirect URI.
2. Let MSAL perform authorization code + PKCE.
3. Acquire the API access token for `VITE_ENTRA_API_SCOPE`; do not send an ID token to the API.

## Cognito email-OTP adapter

```dotenv
VITE_AUTH_PROVIDER=cognito
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=<terraform output>
VITE_COGNITO_CLIENT_ID=<terraform output>
```

Use AWS Amplify Auth or the Cognito Identity Provider SDK with a public client (no client secret):

1. Sign up using the exact school email and no password, then confirm the mailbox code when creating a new account.
2. Start `USER_AUTH` with email as `USERNAME` and `EMAIL_OTP` as the preferred challenge.
3. Respond to the email OTP challenge and retain tokens in the auth library's normal protected storage strategy.
4. Send the Cognito **access token** to the API.

For a new Cognito account, show the activation-code screen before login and call `ConfirmSignUp`; provide a resend action backed by `ResendConfirmationCode`. Entra login does not use this CodeHawks activation screen because Microsoft has already verified the identity.

Keep messages neutral so an unauthenticated screen does not become a reliable account-enumeration endpoint. The backend independently rejects a missing/unverified/non-UNG email even if frontend validation is bypassed.

## API adapter

After either login:

1. Call `GET /v1/me` to provision/load the profile and authoritative club role.
2. Use the member UUID returned by the API; do not use email, Entra `oid`, or Cognito `sub` as an application ID.
3. Replace project/team IDs typed as numbers with UUID strings.
4. Map backend fields into existing view models as needed: `id`, `name`, `description`, `repoUrl`, `imageUrl`, and `memberHandles`.
5. Use `/v1/me/memberships` for “my projects/teams,” protected `/{id}/manage` reads for owner screens, and `/v1/manage/*` queues for officers.
6. Load `/v1/me/notifications?read=false` for an unread badge and `/v1/me/notifications` for the inbox. Use `resourceType` plus `resourceId` for navigation, and mark a notification read after opening it.
7. Let members optionally edit `techStack` on their profile. Do not add a required onboarding gate; an empty array is valid.
8. Build member management from the membership/invitation routes in [api.md](api.md). Search `/v1/members` first to obtain a member UUID for invite/direct-add/transfer operations.
9. For avatars, request a presigned POST, upload directly to S3, then save `publicUrl` on the profile. Do not proxy the file through the API Lambda.
10. For an attached project/team image, create the resource, request its protected `/{id}/image-upload` presigned POST, upload directly to S3, then `PATCH` the resource with `publicUrl` as `imageUrl`. If no image is attached, render the frontend default; do not persist a placeholder URL.
11. Treat `401` as token/session handling, `403` as an actual policy response, `409` as a stale/capacity/business-state response, and show useful field messages from `400` validation errors.

The notification list is cursor-paginated. `read=false` uses a sparse unread index, so it does not walk past read messages. A `read=true` page can still be shorter than its requested limit while returning `nextCursor`. The inbox is pull-based for now; poll on app focus or after membership actions rather than continuously.

Public project/team/event reads need no token. Member search, profiles, invitations, rosters, and every mutation do.

## Newsletter composer

Show the composer only when `/v1/me` reports `reservation_designee`, `treasurer`, `vice_president`, or `president`; this is a usability choice only, because the API independently enforces `newsletters.send`.

Generate one `crypto.randomUUID()` per compose action and send it as `idempotencyKey`. After the API returns `202`, poll `GET /v1/newsletters/{id}` or refresh the newsletter history to display `queued`, `sending`, `sent`, and the delivery counters. Do not ask the browser to provide recipient addresses—the backend always resolves the active-member audience.

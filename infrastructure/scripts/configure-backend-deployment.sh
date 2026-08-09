#!/usr/bin/env bash
set -euo pipefail

owner="${GITHUB_OWNER:-Israel-Jauregui}"
repository="${GITHUB_REPOSITORY_NAME:-CodeHawks-Backend}"
full_name="${owner}/${repository}"

: "${AWS_ACCOUNT_ID:?Copy AwsAccountId from the backend bootstrap stack outputs}"
: "${AWS_REGION:?Copy AwsRegion from the backend bootstrap stack outputs}"
: "${AWS_PLAN_ROLE_ARN:?Copy TerraformPlanRoleArn from the backend bootstrap stack outputs}"
: "${AWS_APPLY_ROLE_ARN:?Copy TerraformApplyRoleArn from the backend bootstrap stack outputs}"
: "${TF_STATE_BUCKET:?Copy TerraformStateBucketName from the backend bootstrap stack outputs}"
: "${RUNTIME_PERMISSIONS_BOUNDARY_ARN:?Copy RuntimePermissionsBoundaryArn from the backend bootstrap stack outputs}"
: "${AUTH_PROVIDER:?Set entra or cognito}"
: "${SES_DOMAIN:?Set the club-owned domain Terraform will register with SES}"
: "${EMAIL_FROM_ADDRESS:?Set the verified From address}"
: "${ALLOWED_ORIGINS:?Set a JSON array of exact HTTPS frontend origins}"

ENTRA_API_CLIENT_ID="${ENTRA_API_CLIENT_ID:-}"
EMAIL_REPLY_TO_ADDRESS="${EMAIL_REPLY_TO_ADDRESS:-}"

[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]]
[[ "$AWS_PLAN_ROLE_ARN" == "arn:aws:iam::${AWS_ACCOUNT_ID}:role/codehawks-backend-terraform-plan" ]]
[[ "$AWS_APPLY_ROLE_ARN" == "arn:aws:iam::${AWS_ACCOUNT_ID}:role/codehawks-backend-terraform-apply" ]]
[[ "$TF_STATE_BUCKET" == "codehawks-backend-terraform-state-${AWS_ACCOUNT_ID}" ]]
[[ "$RUNTIME_PERMISSIONS_BOUNDARY_ARN" == "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/codehawks-backend-runtime-boundary" ]]
[[ "$AUTH_PROVIDER" == "entra" || "$AUTH_PROVIDER" == "cognito" ]]
[[ "$SES_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and startswith("https://"))' \
  <<<"$ALLOWED_ORIGINS" >/dev/null

if [[ "$AUTH_PROVIDER" == "entra" ]]; then
  [[ "$ENTRA_API_CLIENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]]
fi

plan_environment=backend-plan-production
apply_environment=backend-infrastructure-production

set_plan_variable() {
  gh variable set "$1" --repo "$full_name" --env "$plan_environment" --body "$2"
}

set_apply_variable() {
  gh variable set "$1" --repo "$full_name" --env "$apply_environment" --body "$2"
}

set_plan_variable AWS_ACCOUNT_ID "$AWS_ACCOUNT_ID"
set_plan_variable AWS_REGION "$AWS_REGION"
set_plan_variable AWS_PLAN_ROLE_ARN "$AWS_PLAN_ROLE_ARN"
set_plan_variable TF_STATE_BUCKET "$TF_STATE_BUCKET"
set_plan_variable RUNTIME_PERMISSIONS_BOUNDARY_ARN "$RUNTIME_PERMISSIONS_BOUNDARY_ARN"
set_plan_variable AUTH_PROVIDER "$AUTH_PROVIDER"
set_plan_variable ENTRA_API_CLIENT_ID "$ENTRA_API_CLIENT_ID"
set_plan_variable SES_DOMAIN "$SES_DOMAIN"
set_plan_variable EMAIL_FROM_ADDRESS "$EMAIL_FROM_ADDRESS"
set_plan_variable ALLOWED_ORIGINS "$ALLOWED_ORIGINS"

if [[ -n "$EMAIL_REPLY_TO_ADDRESS" ]]; then
  set_plan_variable EMAIL_REPLY_TO_ADDRESS "$EMAIL_REPLY_TO_ADDRESS"
else
  gh variable delete EMAIL_REPLY_TO_ADDRESS \
    --repo "$full_name" \
    --env "$plan_environment" 2>/dev/null || true
fi

set_apply_variable AWS_ACCOUNT_ID "$AWS_ACCOUNT_ID"
set_apply_variable AWS_REGION "$AWS_REGION"
set_apply_variable AWS_APPLY_ROLE_ARN "$AWS_APPLY_ROLE_ARN"
set_apply_variable TF_STATE_BUCKET "$TF_STATE_BUCKET"

if [[ -n "${BUDGET_NOTIFICATION_EMAIL:-}" ]]; then
  gh secret set BUDGET_NOTIFICATION_EMAIL \
    --repo "$full_name" \
    --env "$plan_environment" \
    --body "$BUDGET_NOTIFICATION_EMAIL"
fi

echo "Configured ${full_name} for backend Terraform plans and owner-approved applies."

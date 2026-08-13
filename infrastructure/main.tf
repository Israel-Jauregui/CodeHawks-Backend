locals {
  resource_prefix = "${var.app_name}-${var.environment}"
  common_tags = {
    Application = "CodeHawks"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Owner       = "UNG-App-Development-Club"
  }
  public_routes = toset([
    "GET /health",
    "GET /v1/events",
    "GET /v1/events/{id}",
    "GET /v1/projects",
    "GET /v1/projects/{id}",
    "GET /v1/teams",
    "GET /v1/teams/{id}",
  ])
}

check "authentication_configuration" {
  assert {
    condition     = var.auth_provider != "entra" || var.entra_api_client_id != null
    error_message = "entra_api_client_id is required when auth_provider is entra."
  }

}

check "email_configuration" {
  assert {
    condition     = var.email_from_address != null
    error_message = "email_from_address is required for account and newsletter email."
  }
}

check "production_permissions_boundary" {
  assert {
    condition     = var.environment != "production" || var.runtime_permissions_boundary_arn != null
    error_message = "runtime_permissions_boundary_arn is required in production."
  }
}

locals {
  configured_email_from = coalesce(var.email_from_address, "not-configured@example.invalid")
}

resource "aws_dynamodb_table" "club" {
  name                        = local.resource_prefix
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.enable_deletion_protection

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "gsi2"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = var.enable_point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_sesv2_configuration_set" "newsletters" {
  configuration_set_name = "${local.resource_prefix}-newsletters"

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_email_identity" "club" {
  email_identity         = var.ses_domain
  configuration_set_name = aws_sesv2_configuration_set.newsletters.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_sqs_queue" "newsletter_dlq" {
  name                      = "${local.resource_prefix}-newsletter-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "newsletter" {
  name                       = "${local.resource_prefix}-newsletter"
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 720

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.newsletter_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "newsletter" {
  queue_url = aws_sqs_queue.newsletter_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.newsletter.arn]
  })
}

resource "aws_s3_bucket" "media" {
  bucket        = "${local.resource_prefix}-media-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["POST"]
    allowed_origins = var.allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${local.resource_prefix}-media"
  description                       = "Private access from CodeHawks media CDN to S3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "media" {
  name = "${local.resource_prefix}-media-security"

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "CodeHawks member and club media"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "private-media-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "private-media-s3"
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "media_bucket" {
  statement {
    sid       = "AllowCloudFrontReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_bucket.json
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/../dist/handler.mjs"
  output_path = "${path.module}/lambda.zip"
}

data "archive_file" "cognito_trigger" {
  type        = "zip"
  source_file = "${path.module}/../dist/cognito-trigger.mjs"
  output_path = "${path.module}/cognito-trigger.zip"
}

data "archive_file" "newsletter_worker" {
  type        = "zip"
  source_file = "${path.module}/../dist/newsletter-worker.mjs"
  output_path = "${path.module}/newsletter-worker.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }

}

resource "aws_iam_role" "api" {
  name                 = "${local.resource_prefix}-api"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.runtime_permissions_boundary_arn
}

data "aws_iam_policy_document" "api" {
  statement {
    sid = "ClubTableReadWrite"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.club.arn,
      "${aws_dynamodb_table.club.arn}/index/*",
    ]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    sid     = "CreateMediaUploads"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.media.arn}/avatars/*",
      "${aws_s3_bucket.media.arn}/projects/*",
      "${aws_s3_bucket.media.arn}/teams/*",
    ]
  }

  statement {
    sid       = "QueueNewsletters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.newsletter.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.resource_prefix}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.resource_prefix}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "newsletter_worker" {
  name                 = "${local.resource_prefix}-newsletter-worker"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.runtime_permissions_boundary_arn
}

data "aws_iam_policy_document" "newsletter_worker" {
  statement {
    sid = "ClubTableNewsletterReadWrite"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.club.arn,
      "${aws_dynamodb_table.club.arn}/index/*",
    ]
  }

  statement {
    sid = "ConsumeAndFanoutNewsletterQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.newsletter.arn]
  }

  statement {
    sid       = "SendClubEmail"
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.club.arn, aws_sesv2_configuration_set.newsletters.arn]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.newsletter_worker.arn}:*"]
  }
}

resource "aws_iam_role_policy" "newsletter_worker" {
  name   = "${local.resource_prefix}-newsletter-worker"
  role   = aws_iam_role.newsletter_worker.id
  policy = data.aws_iam_policy_document.newsletter_worker.json
}

resource "aws_cloudwatch_log_group" "newsletter_worker" {
  name              = "/aws/lambda/${local.resource_prefix}-newsletter-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "newsletter_worker" {
  function_name = "${local.resource_prefix}-newsletter-worker"
  description   = "Fans newsletters out to active club members and sends through SES"
  role          = aws_iam_role.newsletter_worker.arn
  architectures = ["arm64"]
  filename      = data.archive_file.newsletter_worker.output_path
  handler       = "newsletter-worker.handler"
  memory_size   = 256
  runtime       = "nodejs22.x"
  timeout       = 120

  source_code_hash = data.archive_file.newsletter_worker.output_base64sha256

  environment {
    variables = {
      EMAIL_FROM_ADDRESS         = local.configured_email_from
      EMAIL_REPLY_TO_ADDRESS     = var.email_reply_to_address == null ? "" : var.email_reply_to_address
      NEWSLETTER_QUEUE_URL       = aws_sqs_queue.newsletter.url
      SES_CONFIGURATION_SET_NAME = aws_sesv2_configuration_set.newsletters.configuration_set_name
      TABLE_NAME                 = aws_dynamodb_table.club.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.newsletter_worker,
    aws_iam_role_policy.newsletter_worker,
  ]
}

resource "aws_lambda_event_source_mapping" "newsletter_worker" {
  batch_size                         = 1
  event_source_arn                   = aws_sqs_queue.newsletter.arn
  function_name                      = aws_lambda_function.newsletter_worker.arn
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 0
}

resource "aws_cloudwatch_metric_alarm" "newsletter_dlq" {
  alarm_name          = "${local.resource_prefix}-newsletter-dlq-not-empty"
  alarm_description   = "Newsletter jobs exhausted retries and require officer/operator review."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.newsletter_dlq.name
  }
}

resource "aws_iam_role" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  name                 = "${local.resource_prefix}-cognito-trigger"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.runtime_permissions_boundary_arn
}

data "aws_iam_policy_document" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.cognito_trigger[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  name   = "${local.resource_prefix}-cognito-trigger"
  role   = aws_iam_role.cognito_trigger[0].id
  policy = data.aws_iam_policy_document.cognito_trigger[0].json
}

resource "aws_cloudwatch_log_group" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  name              = "/aws/lambda/${local.resource_prefix}-cognito-trigger"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  function_name = "${local.resource_prefix}-cognito-trigger"
  description   = "Enforces the UNG domain and adds verified email claims to Cognito access tokens"
  role          = aws_iam_role.cognito_trigger[0].arn
  architectures = ["arm64"]
  filename      = data.archive_file.cognito_trigger.output_path
  handler       = "cognito-trigger.handler"
  memory_size   = 128
  runtime       = "nodejs22.x"
  timeout       = 5

  source_code_hash = data.archive_file.cognito_trigger.output_base64sha256

  environment {
    variables = {
      ALLOWED_EMAIL_DOMAIN = lower(var.allowed_email_domain)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.cognito_trigger,
    aws_iam_role_policy.cognito_trigger,
  ]
}

resource "aws_cognito_user_pool" "members" {
  count = var.auth_provider == "cognito" ? 1 : 0

  name                     = "${local.resource_prefix}-members"
  user_pool_tier           = "ESSENTIALS"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  deletion_protection      = var.enable_deletion_protection ? "ACTIVE" : "INACTIVE"

  sign_in_policy {
    allowed_first_auth_factors = ["EMAIL_OTP"]
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    from_email_address    = local.configured_email_from
    source_arn            = aws_sesv2_email_identity.club.arn
  }

  email_verification_message = "Welcome to CodeHawks. Your account activation code is {####}. This code expires automatically; ignore this email if you did not sign up."
  email_verification_subject = "Activate your CodeHawks account"

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.cognito_trigger[0].arn

    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.cognito_trigger[0].arn
      lambda_version = "V2_0"
    }
  }

  schema {
    attribute_data_type = "String"
    mutable             = true
    name                = "email"
    required            = true

    string_attribute_constraints {
      max_length = "320"
      min_length = "3"
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  count = var.auth_provider == "cognito" ? 1 : 0

  name                          = "${local.resource_prefix}-web"
  user_pool_id                  = aws_cognito_user_pool.members[0].id
  generate_secret               = false
  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH"]
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_lambda_permission" "cognito_trigger" {
  count = var.auth_provider == "cognito" ? 1 : 0

  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_trigger[0].function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.members[0].arn
}

locals {
  auth_issuer = var.auth_provider == "entra" ? (
    "https://login.microsoftonline.com/${lower(var.entra_tenant_id)}/v2.0"
    ) : (
    "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.members[0].id}"
  )
  auth_audience = var.auth_provider == "entra" ? coalesce(var.entra_api_client_id, "not-configured") : aws_cognito_user_pool_client.web[0].id
}

resource "aws_lambda_function" "api" {
  function_name = "${local.resource_prefix}-api"
  description   = "CodeHawks club API"
  role          = aws_iam_role.api.arn
  architectures = ["arm64"]
  filename      = data.archive_file.lambda.output_path
  handler       = "handler.handler"
  memory_size   = 256
  runtime       = "nodejs22.x"
  timeout       = 10

  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      ALLOWED_EMAIL_DOMAIN  = lower(var.allowed_email_domain)
      AUTH_PROVIDER         = var.auth_provider
      COGNITO_CLIENT_ID     = var.auth_provider == "cognito" ? aws_cognito_user_pool_client.web[0].id : ""
      COGNITO_ISSUER        = var.auth_provider == "cognito" ? local.auth_issuer : ""
      ENTRA_API_CLIENT_ID   = var.auth_provider == "entra" ? coalesce(var.entra_api_client_id, "not-configured") : ""
      ENTRA_TENANT_ID       = var.auth_provider == "entra" ? lower(var.entra_tenant_id) : ""
      LOG_LEVEL             = var.environment == "production" ? "info" : "debug"
      MEDIA_BUCKET_NAME     = aws_s3_bucket.media.id
      MEDIA_PUBLIC_BASE_URL = "https://${aws_cloudfront_distribution.media.domain_name}"
      NEWSLETTER_QUEUE_URL  = aws_sqs_queue.newsletter.url
      TABLE_NAME            = aws_dynamodb_table.club.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
}

resource "aws_cloudwatch_log_group" "http_api" {
  name              = "/aws/apigateway/${local.resource_prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.resource_prefix
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = false
    allow_headers     = ["authorization", "content-type"]
    allow_methods     = ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]
    allow_origins     = var.allowed_origins
    expose_headers    = ["x-request-id"]
    max_age           = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "auth" {
  api_id           = aws_apigatewayv2_api.api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "club-auth-${var.auth_provider}"

  jwt_configuration {
    audience = [local.auth_audience]
    issuer   = local.auth_issuer
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "public" {
  for_each = local.public_routes

  api_id             = aws_apigatewayv2_api.api.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "authenticated" {
  api_id               = aws_apigatewayv2_api.api.id
  authorization_scopes = var.auth_provider == "entra" ? [var.entra_required_scope] : null
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.auth.id
  route_key            = "ANY /v1/{proxy+}"
  target               = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# A browser preflight never includes the bearer token used by the eventual
# request. This method-specific route must outrank the authenticated ANY route
# so API Gateway can return its configured CORS response without invoking the
# JWT authorizer.
resource "aws_apigatewayv2_route" "cors_preflight" {
  api_id             = aws_apigatewayv2_api.api.id
  authorization_type = "NONE"
  route_key          = "OPTIONS /v1/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  auto_deploy = true
  name        = "$default"

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.http_api.arn
    format = jsonencode({
      httpMethod       = "$context.httpMethod"
      integrationError = "$context.integrationErrorMessage"
      ip               = "$context.identity.sourceIp"
      protocol         = "$context.protocol"
      requestId        = "$context.requestId"
      responseLength   = "$context.responseLength"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = false
    throttling_burst_limit   = 50
    throttling_rate_limit    = 25
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_budgets_budget" "monthly" {
  count = var.budget_notification_email == null ? 0 : 1

  name         = "${local.resource_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = compact([var.budget_notification_email])
  }
}

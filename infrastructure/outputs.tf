output "api_url" {
  description = "Base URL for the HTTP API."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "dynamodb_table_name" {
  description = "Single DynamoDB table used by the backend."
  value       = aws_dynamodb_table.club.name
}

output "lambda_function_name" {
  description = "Backend Lambda function name."
  value       = aws_lambda_function.api.function_name
}

output "auth_issuer" {
  description = "Issuer configured on the API Gateway JWT authorizer."
  value       = aws_apigatewayv2_authorizer.auth.jwt_configuration[0].issuer
}

output "auth_provider" {
  description = "Authentication provider selected for this deployment."
  value       = var.auth_provider
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID in fallback mode, otherwise null."
  value       = var.auth_provider == "cognito" ? aws_cognito_user_pool.members[0].id : null
}

output "cognito_web_client_id" {
  description = "Cognito public app-client ID in fallback mode, otherwise null."
  value       = var.auth_provider == "cognito" ? aws_cognito_user_pool_client.web[0].id : null
}

output "media_public_base_url" {
  description = "CloudFront base URL for public media."
  value       = "https://${aws_cloudfront_distribution.media.domain_name}"
}

output "newsletter_queue_name" {
  description = "SQS queue buffering newsletter fanout and delivery jobs."
  value       = aws_sqs_queue.newsletter.name
}

output "newsletter_dead_letter_queue_name" {
  description = "Queue containing newsletter jobs that exhausted automatic retries."
  value       = aws_sqs_queue.newsletter_dlq.name
}

output "newsletter_worker_function_name" {
  description = "Lambda worker that sends role-authorized newsletters through SES."
  value       = aws_lambda_function.newsletter_worker.function_name
}

output "ses_configuration_set_name" {
  description = "SES configuration set used for newsletter suppression and reputation metrics."
  value       = aws_sesv2_configuration_set.newsletters.configuration_set_name
}

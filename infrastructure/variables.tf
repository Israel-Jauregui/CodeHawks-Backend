variable "app_name" {
  description = "Short application name used in AWS resource names."
  type        = string
  default     = "codehawks"
}

variable "environment" {
  description = "Deployment environment such as dev or production."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging, or production."
  }
}

variable "aws_region" {
  description = "AWS region for the API and DynamoDB table."
  type        = string
  default     = "us-east-1"
}

variable "auth_provider" {
  description = "Authentication boundary: externally owned multitenant Entra first, or Cognito passwordless email OTP when UNG blocks consent."
  type        = string
  default     = "entra"

  validation {
    condition     = contains(["entra", "cognito"], var.auth_provider)
    error_message = "auth_provider must be entra or cognito."
  }
}

variable "entra_tenant_id" {
  description = "UNG Microsoft Entra tenant (directory) ID."
  type        = string
  default     = "b8e6c58e-d6fa-4f4a-968c-d4be658dfe8e"
}

variable "entra_api_client_id" {
  description = "Application/client ID for our externally owned multitenant Entra API registration. Required in entra mode; not a secret."
  type        = string
  default     = null
  nullable    = true
}

variable "entra_required_scope" {
  description = "Delegated Entra scope required by protected API routes."
  type        = string
  default     = "access_as_user"
}

variable "ses_identity_arn" {
  description = "Verified SES domain/email identity ARN used for newsletters and Cognito messages. Required for every deployment."
  type        = string
  default     = null
  nullable    = true
}

variable "email_from_address" {
  description = "Verified From address for newsletters and account messages, for example CodeHawks <noreply@codehawks.org>."
  type        = string
  default     = null
  nullable    = true
}

variable "email_reply_to_address" {
  description = "Optional Reply-To address for newsletters."
  type        = string
  default     = null
  nullable    = true
}

variable "allowed_email_domain" {
  description = "School email domain accepted after tenant validation."
  type        = string
  default     = "ung.edu"
}

variable "allowed_origins" {
  description = "Exact frontend origins allowed by API Gateway CORS. Do not use a wildcard in production."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "enable_point_in_time_recovery" {
  description = "Enable DynamoDB continuous backups. Recommended for production."
  type        = bool
  default     = true
}

variable "enable_deletion_protection" {
  description = "Protect the DynamoDB table from accidental deletion."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget. Used only when budget_notification_email is set."
  type        = number
  default     = 10
}

variable "budget_notification_email" {
  description = "Optional email for AWS Budget notifications."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "runtime_permissions_boundary_arn" {
  description = "Permissions boundary attached to Terraform-created Lambda roles. Required in production."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.runtime_permissions_boundary_arn == null ||
      can(regex("^arn:aws:iam::[0-9]{12}:policy/codehawks-backend-runtime-boundary$", var.runtime_permissions_boundary_arn))
    )
    error_message = "runtime_permissions_boundary_arn must be the CodeHawks backend runtime boundary ARN."
  }
}

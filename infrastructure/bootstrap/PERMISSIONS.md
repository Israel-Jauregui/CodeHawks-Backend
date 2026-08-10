# Backend bootstrap permission audit

The bootstrap has three permission boundaries with deliberately different jobs:

- `TerraformPlanBoundary` refreshes existing AWS state and writes only the
  Terraform lock and private plan bundle.
- `TerraformApplyBoundary` performs the owner-approved resource lifecycle from
  an exact reviewed plan. It cannot modify its own role, trust policy, managed
  policy, or permissions boundary.
- `RuntimePermissionsBoundary` limits the application Lambda roles and contains
  no infrastructure-administration permissions.

## Terraform lifecycle coverage

| Terraform surface | Plan refresh coverage | Apply lifecycle coverage |
| --- | --- | --- |
| Terraform state and plan bundle | Exact state bucket keys and prefixes | Exact state bucket keys and prefixes |
| DynamoDB table and indexes | Describe, recovery, TTL, insights, and tags on the CodeHawks table | Table and index lifecycle on the CodeHawks table ARNs |
| Media S3 bucket and policy | Read/list on the named media bucket | Bucket lifecycle on the named media bucket and its objects |
| Lambda functions and permissions | Function get/list/tag reads on `codehawks-production-*` | Function lifecycle on `codehawks-production-*` |
| Newsletter event-source mapping | List globally; get/tags on regional mapping ARNs | Create only when `lambda:FunctionArn` matches the CodeHawks prefix; mapping lifecycle on regional mapping ARNs |
| CloudWatch Logs groups | Describe globally; tags on named CodeHawks groups | Log-group lifecycle on named CodeHawks groups |
| API Gateway access-log delivery | Not a Terraform state resource | Account-level V1 delivery and resource-policy operations required by CloudWatch Logs |
| SQS newsletter queue and DLQ | Queue attributes, URL, and tags on the CodeHawks queue prefix | Queue lifecycle on the CodeHawks queue prefix |
| CloudWatch alarm | Describe globally; tags on the CodeHawks alarm prefix | Alarm lifecycle on the CodeHawks alarm prefix |
| SES identity and configuration set | Regional identity/configuration reads | Lifecycle on the CodeHawks SES identity and configuration set |
| API Gateway HTTP API | Regional API reads | Lifecycle under the regional `/apis` and `/tags` paths |
| CloudFront media distribution and policies | Global CloudFront reads | CloudFront lifecycle; create/list APIs require wildcard resources |
| Cognito fallback resources | Regional pool reads | Tagged pool creation, regional pool lifecycle, and a conditioned email service-linked role |
| AWS Budget | Account-level budget and tag reads | Account-level CodeHawks budget lifecycle and its conditioned service-linked role |
| Lambda runtime IAM roles | Reads on the three exact role names | Lifecycle on those exact names, with the runtime boundary required at creation and `PassRole` restricted to Lambda |

## Unavoidable wildcard-resource statements

Some AWS actions do not support resource-level permissions. Keep them isolated
instead of widening the resource-scoped service statements:

- `lambda:CreateEventSourceMapping` and `lambda:ListEventSourceMappings` require
  `Resource: "*"`. Creation is additionally restricted with
  `lambda:FunctionArn` to the CodeHawks function prefix. AWS assigns the mapping
  UUID, so later mapping lifecycle actions use the regional account mapping ARN
  wildcard.
- CloudWatch Logs V1 delivery actions and log resource-policy operations require
  `Resource: "*"`. They are required for API Gateway access logging; ordinary
  log-group management remains restricted to the named CodeHawks groups.
- CloudFront create/list operations, account billing/budget operations, and
  service discovery reads are account/global APIs. They remain in dedicated
  statements and do not grant IAM administration.

## Change rule

Before adding a Terraform resource or data source, enumerate its provider CRUD,
tagging, list, and dependent-service calls. Add read coverage to the plan role,
full lifecycle coverage to the apply role, and runtime calls only to the runtime
boundary. Prefer exact ARNs, then prefix ARNs, then supported condition keys;
use `Resource: "*"` only when the AWS service authorization model requires it.

CI runs `check_policy_invariants.py` after `cfn-lint`. The check protects the
known account-level Lambda/log-delivery requirements and enforces a 5,800
character safety budget below IAM's managed-policy size limit.

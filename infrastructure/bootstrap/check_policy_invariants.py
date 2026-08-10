#!/usr/bin/env python3
"""Static guardrails for the bootstrap IAM managed policies."""

import json
import re
from pathlib import Path

import yaml


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_intrinsic(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag_suffix: value}


CloudFormationLoader.add_multi_constructor("!", construct_intrinsic)

template_path = Path(__file__).with_name("template.yaml")
template = yaml.load(template_path.read_text(encoding="utf-8"), Loader=CloudFormationLoader)

replacements = {
    "AWS::Partition": "aws",
    "AWS::Region": "us-east-1",
    "AWS::AccountId": "000000000000",
    "AppResourcePrefix": "codehawks-production",
    "TerraformStateBucket.Arn": "arn:aws:s3:::codehawks-backend-terraform-state-000000000000",
    "TerraformStateBucket": "codehawks-backend-terraform-state-000000000000",
    "RuntimePermissionsBoundary": "arn:aws:iam::000000000000:policy/codehawks-backend-runtime-boundary",
}


def substitute(value):
    return re.sub(
        r"\$\{([^}]+)\}",
        lambda match: replacements.get(match.group(1), "resolved-value"),
        value,
    )


def resolve(value):
    if isinstance(value, list):
        return [resolve(item) for item in value]
    if isinstance(value, dict):
        if set(value) == {"Sub"}:
            return substitute(value["Sub"])
        if set(value) == {"GetAtt"}:
            return replacements.get(value["GetAtt"], "resolved-value")
        if set(value) == {"Ref"}:
            return replacements.get(value["Ref"], "resolved-value")
        return {key: resolve(item) for key, item in value.items()}
    return value


def policy(name):
    return template["Resources"][name]["Properties"]["PolicyDocument"]


def actions(statement):
    value = statement["Action"]
    return value if isinstance(value, list) else [value]


def resources(statement):
    value = statement["Resource"]
    return value if isinstance(value, list) else [value]


def unscoped_statement(policy_document, action):
    return next(
        (
            statement
            for statement in policy_document["Statement"]
            if action in actions(statement) and statement["Resource"] == "*"
        ),
        None,
    )


size_budget = 5800
for policy_name in (
    "TerraformPlanBoundary",
    "TerraformApplyBoundary",
    "RuntimePermissionsBoundary",
):
    rendered_size = len(json.dumps(resolve(policy(policy_name)), separators=(",", ":")))
    if rendered_size > size_budget:
        raise SystemExit(
            f"{policy_name} renders to {rendered_size} characters; "
            f"the repository safety budget is {size_budget}."
        )
    print(f"{policy_name}: {rendered_size}/{size_budget} characters")

plan_policy = policy("TerraformPlanBoundary")
apply_policy = policy("TerraformApplyBoundary")

if unscoped_statement(plan_policy, "lambda:ListEventSourceMappings") is None:
    raise SystemExit("Plan role must list Lambda event-source mappings.")

create_mapping = unscoped_statement(apply_policy, "lambda:CreateEventSourceMapping")
if create_mapping is None or "lambda:FunctionArn" not in json.dumps(create_mapping.get("Condition", {})):
    raise SystemExit(
        "Apply role must create event-source mappings with a CodeHawks Lambda ARN condition."
    )

create_user_pool = unscoped_statement(apply_policy, "cognito-idp:CreateUserPool")
if create_user_pool is None or "aws:RequestTag" not in json.dumps(
    create_user_pool.get("Condition", {})
):
    raise SystemExit("Cognito pool creation must require CodeHawks request tags.")

for required_action in (
    "lambda:ListEventSourceMappings",
    "logs:CreateLogDelivery",
    "logs:DescribeResourcePolicies",
    "logs:PutResourcePolicy",
):
    if unscoped_statement(apply_policy, required_action) is None:
        raise SystemExit(f"Apply role is missing required account-level action {required_action}.")

lambda_mapping_arn = "event-source-mapping:*"
if not any(
    "lambda:*" in actions(statement)
    and any(lambda_mapping_arn in json.dumps(resource) for resource in resources(statement))
    for statement in apply_policy["Statement"]
):
    raise SystemExit("Apply role must manage the lifecycle of regional event-source mappings.")

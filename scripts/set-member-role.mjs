import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const allowedRoles = new Set([
  'member',
  'reservation_designee',
  'treasurer',
  'vice_president',
  'president',
]);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tableName = argument('table');
const memberId = argument('member-id');
const role = argument('role');

if (!tableName || !memberId || !role || !allowedRoles.has(role)) {
  console.error(
    'Usage: npm run bootstrap:role -- --table <table> --member-id <member-uuid> --role <role>',
  );
  process.exitCode = 2;
} else {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await client.send(
    new UpdateCommand({
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': role, ':updatedAt': new Date().toISOString() },
      Key: { pk: `USER#${memberId.toLowerCase()}`, sk: 'PROFILE' },
      TableName: tableName,
      UpdateExpression: 'SET #role = :role, updatedAt = :updatedAt',
    }),
  );
  console.log(`Updated ${memberId} to ${role} in ${tableName}.`);
}

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

const jsonHeaders = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    body: JSON.stringify(body),
    headers: { ...jsonHeaders, ...headers },
    statusCode,
  };
}

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204 };
}

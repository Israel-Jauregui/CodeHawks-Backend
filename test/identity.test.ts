import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { identityFromEvent } from '../src/auth/identity.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  allowedEmailDomain: 'ung.edu',
  authProvider: 'entra',
  entraApiClientId: 'api-client-id',
  entraTenantId: 'tenant-id',
  logLevel: 'info',
  mediaBucketName: 'media',
  mediaPublicBaseUrl: 'https://media.example.test',
  newsletterQueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/newsletters',
  tableName: 'table',
};

function eventWithClaims(
  claims: Record<string, string>,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    headers: {},
    isBase64Encoded: false,
    rawPath: '/v1/me',
    rawQueryString: '',
    requestContext: {
      accountId: 'account',
      apiId: 'api',
      authorizer: {
        integrationLatency: 0,
        jwt: { claims, scopes: ['access_as_user'] },
        principalId: 'object-id',
      },
      domainName: 'example.test',
      domainPrefix: 'example',
      http: { method: 'GET', path: '/v1/me', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'request-id',
      routeKey: 'ANY /v1/{proxy+}',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    routeKey: 'ANY /v1/{proxy+}',
    version: '2.0',
  };
}

describe('identityFromEvent', () => {
  it('uses immutable Entra object identity and accepts UNG users', () => {
    const identity = identityFromEvent(
      eventWithClaims({
        aud: 'api-client-id',
        name: 'Ada Lovelace',
        oid: 'OBJECT-ID',
        preferred_username: 'ada@ung.edu',
        tid: 'TENANT-ID',
      }),
      config,
    );

    expect(identity).toEqual({
      displayName: 'Ada Lovelace',
      email: 'ada@ung.edu',
      emailVerified: true,
      provider: 'entra',
      subject: 'object-id',
      tenantId: 'tenant-id',
    });
  });

  it('accepts a verified UNG Cognito access token in fallback mode', () => {
    const cognitoConfig: AppConfig = {
      allowedEmailDomain: 'ung.edu',
      authProvider: 'cognito',
      cognitoClientId: 'cognito-client-id',
      cognitoIssuer: 'https://cognito-idp.us-east-1.amazonaws.com/pool-id',
      logLevel: 'info',
      mediaBucketName: 'media',
      mediaPublicBaseUrl: 'https://media.example.test',
      newsletterQueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/newsletters',
      tableName: 'table',
    };
    const identity = identityFromEvent(
      eventWithClaims({
        client_id: 'cognito-client-id',
        email: 'ada@ung.edu',
        email_verified: 'true',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/pool-id',
        sub: 'COGNITO-SUBJECT',
        token_use: 'access',
      }),
      cognitoConfig,
    );

    expect(identity).toMatchObject({
      email: 'ada@ung.edu',
      emailVerified: true,
      provider: 'cognito',
      subject: 'cognito-subject',
    });
  });

  it('rejects an unverified Cognito email', () => {
    const cognitoConfig: AppConfig = {
      allowedEmailDomain: 'ung.edu',
      authProvider: 'cognito',
      cognitoClientId: 'cognito-client-id',
      cognitoIssuer: 'https://cognito-idp.us-east-1.amazonaws.com/pool-id',
      logLevel: 'info',
      mediaBucketName: 'media',
      mediaPublicBaseUrl: 'https://media.example.test',
      newsletterQueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/newsletters',
      tableName: 'table',
    };
    expect(() =>
      identityFromEvent(
        eventWithClaims({
          client_id: 'cognito-client-id',
          email: 'ada@ung.edu',
          email_verified: 'false',
          iss: 'https://cognito-idp.us-east-1.amazonaws.com/pool-id',
          sub: 'subject',
          token_use: 'access',
        }),
        cognitoConfig,
      ),
    ).toThrow('The school email address has not been verified.');
  });

  it('rejects a non-UNG email even in the configured tenant', () => {
    expect(() =>
      identityFromEvent(
        eventWithClaims({ aud: 'api-client-id', oid: 'object-id', preferred_username: 'guest@example.com', tid: 'tenant-id' }),
        config,
      ),
    ).toThrow('Only @ung.edu accounts are allowed.');
  });

  it('rejects a token issued for another tenant', () => {
    expect(() =>
      identityFromEvent(
        eventWithClaims({ aud: 'api-client-id', oid: 'object-id', preferred_username: 'ada@ung.edu', tid: 'other-tenant' }),
        config,
      ),
    ).toThrow('Only accounts in the configured UNG Entra tenant are allowed.');
  });

  it('rejects a token issued to another API', () => {
    expect(() =>
      identityFromEvent(
        eventWithClaims({ aud: 'other-api', oid: 'object-id', preferred_username: 'ada@ung.edu', tid: 'tenant-id' }),
        config,
      ),
    ).toThrow('The access token was not issued for this API.');
  });
});

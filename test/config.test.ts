import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnvironment = {
  ALLOWED_EMAIL_DOMAIN: 'ung.edu',
  LOG_LEVEL: 'info',
  MEDIA_BUCKET_NAME: 'media',
  MEDIA_PUBLIC_BASE_URL: 'https://media.example.test',
  NEWSLETTER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/newsletters',
  TABLE_NAME: 'table',
};

describe('loadConfig', () => {
  it('allows Terraform empty placeholders for the inactive auth provider', () => {
    const config = loadConfig({
      ...baseEnvironment,
      AUTH_PROVIDER: 'entra',
      COGNITO_CLIENT_ID: '',
      COGNITO_ISSUER: '',
      ENTRA_API_CLIENT_ID: 'api-client-id',
      ENTRA_TENANT_ID: 'UNG-TENANT-ID',
    });

    expect(config).toMatchObject({
      authProvider: 'entra',
      entraApiClientId: 'api-client-id',
      entraTenantId: 'ung-tenant-id',
    });
    expect(config).not.toHaveProperty('cognitoIssuer');
  });

  it('requires the selected Cognito issuer and app client', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        AUTH_PROVIDER: 'cognito',
        COGNITO_CLIENT_ID: '',
        COGNITO_ISSUER: '',
      }),
    ).toThrow('COGNITO_CLIENT_ID and COGNITO_ISSUER are required');
  });
});

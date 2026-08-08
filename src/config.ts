import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const configSchema = z.object({
  ALLOWED_EMAIL_DOMAIN: z.string().min(1).default('ung.edu'),
  AUTH_PROVIDER: z.enum(['entra', 'cognito']).default('entra'),
  COGNITO_CLIENT_ID: optionalString,
  COGNITO_ISSUER: optionalUrl,
  ENTRA_API_CLIENT_ID: optionalString,
  ENTRA_TENANT_ID: optionalString,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MEDIA_BUCKET_NAME: z.string().min(1),
  MEDIA_PUBLIC_BASE_URL: z.string().url(),
  NEWSLETTER_QUEUE_URL: z.string().url(),
  TABLE_NAME: z.string().min(1),
});

export type AppConfig = {
  allowedEmailDomain: string;
  authProvider: 'entra' | 'cognito';
  cognitoClientId?: string;
  cognitoIssuer?: string;
  entraApiClientId?: string;
  entraTenantId?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  mediaBucketName: string;
  mediaPublicBaseUrl: string;
  newsletterQueueUrl: string;
  tableName: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);

  if (parsed.AUTH_PROVIDER === 'entra' && (!parsed.ENTRA_API_CLIENT_ID || !parsed.ENTRA_TENANT_ID)) {
    throw new Error('ENTRA_API_CLIENT_ID and ENTRA_TENANT_ID are required for Entra authentication.');
  }
  if (parsed.AUTH_PROVIDER === 'cognito' && (!parsed.COGNITO_CLIENT_ID || !parsed.COGNITO_ISSUER)) {
    throw new Error('COGNITO_CLIENT_ID and COGNITO_ISSUER are required for Cognito authentication.');
  }

  return {
    allowedEmailDomain: parsed.ALLOWED_EMAIL_DOMAIN.toLowerCase(),
    authProvider: parsed.AUTH_PROVIDER,
    ...(parsed.COGNITO_CLIENT_ID ? { cognitoClientId: parsed.COGNITO_CLIENT_ID } : {}),
    ...(parsed.COGNITO_ISSUER ? { cognitoIssuer: parsed.COGNITO_ISSUER } : {}),
    ...(parsed.ENTRA_API_CLIENT_ID ? { entraApiClientId: parsed.ENTRA_API_CLIENT_ID } : {}),
    ...(parsed.ENTRA_TENANT_ID ? { entraTenantId: parsed.ENTRA_TENANT_ID.toLowerCase() } : {}),
    logLevel: parsed.LOG_LEVEL,
    mediaBucketName: parsed.MEDIA_BUCKET_NAME,
    mediaPublicBaseUrl: parsed.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, ''),
    newsletterQueueUrl: parsed.NEWSLETTER_QUEUE_URL,
    tableName: parsed.TABLE_NAME,
  };
}

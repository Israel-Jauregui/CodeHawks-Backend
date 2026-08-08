import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { AppConfig } from '../config.js';
import type { AuthenticatedIdentity } from '../domain/entities.js';
import { forbidden, unauthorized } from '../lib/errors.js';

type JwtEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

function claim(claims: Record<string, string | number | boolean | string[] | undefined>, key: string) {
  const value = claims[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizedDomain(email: string): string | undefined {
  const separator = email.lastIndexOf('@');
  return separator > 0 ? email.slice(separator + 1).toLowerCase() : undefined;
}

export function identityFromEvent(event: JwtEvent, config: AppConfig): AuthenticatedIdentity {
  const claims = event.requestContext.authorizer?.jwt.claims;
  if (!claims) {
    throw unauthorized();
  }

  const email = (
    claim(claims, 'email') ??
    claim(claims, 'preferred_username') ??
    claim(claims, 'upn')
  )?.toLowerCase();

  if (!email) {
    throw unauthorized('The access token is missing a usable email identity.');
  }
  if (normalizedDomain(email) !== config.allowedEmailDomain) {
    throw forbidden(`Only @${config.allowedEmailDomain} accounts are allowed.`);
  }

  if (config.authProvider === 'cognito') {
    const subject = claim(claims, 'sub');
    const clientId = claim(claims, 'client_id');
    const issuer = claim(claims, 'iss');
    const tokenUse = claim(claims, 'token_use');
    const emailVerified = claim(claims, 'email_verified') === 'true';

    if (!subject || !clientId || !issuer || tokenUse !== 'access') {
      throw unauthorized('The token is not a Cognito user access token.');
    }
    if (clientId !== config.cognitoClientId || issuer !== config.cognitoIssuer) {
      throw unauthorized('The access token was not issued for this API.');
    }
    if (!emailVerified) {
      throw forbidden('The school email address has not been verified.');
    }

    return {
      displayName: claim(claims, 'name') ?? email.slice(0, email.lastIndexOf('@')),
      email,
      emailVerified: true,
      provider: 'cognito',
      subject: subject.toLowerCase(),
    };
  }

  const tenantId = claim(claims, 'tid')?.toLowerCase();
  const objectId = claim(claims, 'oid');
  const audience = claim(claims, 'aud');

  if (!tenantId || !objectId || !audience) {
    throw unauthorized('The access token is missing required Entra user claims.');
  }
  if (audience !== config.entraApiClientId) {
    throw unauthorized('The access token was not issued for this API.');
  }
  if (tenantId !== config.entraTenantId) {
    throw forbidden('Only accounts in the configured UNG Entra tenant are allowed.');
  }

  return {
    displayName: claim(claims, 'name') ?? email.slice(0, email.lastIndexOf('@')),
    email,
    emailVerified: true,
    provider: 'entra',
    subject: objectId.toLowerCase(),
    tenantId,
  };
}

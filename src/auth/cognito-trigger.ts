interface CognitoTriggerEvent {
  triggerSource: string;
  request: {
    userAttributes: Record<string, string | undefined>;
  };
  response: {
    claimsAndScopeOverrideDetails?: {
      accessTokenGeneration: {
        claimsToAddOrOverride: Record<string, string>;
      };
    };
  };
}

function emailDomain(email: string): string | undefined {
  const separator = email.lastIndexOf('@');
  return separator > 0 ? email.slice(separator + 1).toLowerCase() : undefined;
}

export function handler(event: CognitoTriggerEvent): CognitoTriggerEvent {
  const email = event.request.userAttributes.email?.trim().toLowerCase();
  const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'ung.edu').toLowerCase();

  if (!email || emailDomain(email) !== allowedDomain) {
    throw new Error(`Only @${allowedDomain} email addresses can create an account.`);
  }

  if (event.triggerSource.startsWith('TokenGeneration_')) {
    event.response.claimsAndScopeOverrideDetails = {
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          email,
          email_verified: event.request.userAttributes.email_verified ?? 'false',
        },
      },
    };
  }

  return event;
}

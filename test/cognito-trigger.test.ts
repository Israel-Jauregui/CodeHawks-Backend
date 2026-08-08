import { describe, expect, it } from 'vitest';
import { handler } from '../src/auth/cognito-trigger.js';

function triggerEvent(triggerSource: string, email: string, verified = 'false') {
  return {
    request: { userAttributes: { email, email_verified: verified } },
    response: {},
    triggerSource,
  };
}

describe('Cognito domain trigger', () => {
  it('allows exact UNG addresses during sign-up', () => {
    const event = triggerEvent('PreSignUp_SignUp', 'Student@UNG.EDU');
    expect(handler(event)).toBe(event);
  });

  it('rejects lookalike email domains', () => {
    expect(() => handler(triggerEvent('PreSignUp_SignUp', 'student@evilung.edu'))).toThrow(
      'Only @ung.edu email addresses',
    );
  });

  it('copies the verified school email into access-token claims', () => {
    const event = triggerEvent('TokenGeneration_Authentication', 'student@ung.edu', 'true');
    const result = handler(event);

    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          email: 'student@ung.edu',
          email_verified: 'true',
        },
      },
    });
  });
});

import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const schema = z.object({
  EMAIL_FROM_ADDRESS: z.string().min(3),
  EMAIL_REPLY_TO_ADDRESS: optionalString,
  NEWSLETTER_QUEUE_URL: z.string().url(),
  SES_CONFIGURATION_SET_NAME: optionalString,
  TABLE_NAME: z.string().min(1),
});

export interface EmailWorkerConfig {
  emailFromAddress: string;
  emailReplyToAddress?: string;
  newsletterQueueUrl: string;
  sesConfigurationSetName?: string;
  tableName: string;
}

export function loadEmailWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EmailWorkerConfig {
  const parsed = schema.parse(environment);
  return {
    emailFromAddress: parsed.EMAIL_FROM_ADDRESS,
    ...(parsed.EMAIL_REPLY_TO_ADDRESS
      ? { emailReplyToAddress: parsed.EMAIL_REPLY_TO_ADDRESS }
      : {}),
    newsletterQueueUrl: parsed.NEWSLETTER_QUEUE_URL,
    ...(parsed.SES_CONFIGURATION_SET_NAME
      ? { sesConfigurationSetName: parsed.SES_CONFIGURATION_SET_NAME }
      : {}),
    tableName: parsed.TABLE_NAME,
  };
}

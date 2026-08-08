import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { DynamoClubRepository } from '../repositories/dynamo-club-repository.js';
import { loadEmailWorkerConfig } from './email-worker-config.js';
import { newsletterJobSchema, SqsNewsletterQueue } from './newsletter-queue.js';
import { NewsletterWorker } from './newsletter-worker.js';
import { SesNewsletterEmailSender } from './ses-email-sender.js';

const config = loadEmailWorkerConfig();
const worker = new NewsletterWorker(
  new DynamoClubRepository(config.tableName),
  new SqsNewsletterQueue(config.newsletterQueueUrl),
  new SesNewsletterEmailSender(
    config.emailFromAddress,
    config.emailReplyToAddress,
    config.sesConfigurationSetName,
  ),
);

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await worker.process(newsletterJobSchema.parse(JSON.parse(record.body) as unknown));
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? { message: error.message, name: error.name } : 'Unknown',
          level: 'error',
          messageId: record.messageId,
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

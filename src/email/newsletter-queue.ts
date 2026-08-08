import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';

export const newsletterJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newsletter_fanout'), newsletterId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('newsletter_delivery'),
      memberId: z.string().uuid(),
      newsletterId: z.string().uuid(),
    })
    .strict(),
]);

export type NewsletterJob = z.infer<typeof newsletterJobSchema>;

export interface NewsletterQueue {
  startNewsletter(newsletterId: string): Promise<void>;
  enqueueDeliveries(newsletterId: string, memberIds: string[]): Promise<void>;
}

export class SqsNewsletterQueue implements NewsletterQueue {
  public constructor(
    private readonly queueUrl: string,
    private readonly client: SQSClient = new SQSClient({}),
  ) {}

  public async startNewsletter(newsletterId: string): Promise<void> {
    const job: NewsletterJob = { kind: 'newsletter_fanout', newsletterId };
    await this.client.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify(job),
        QueueUrl: this.queueUrl,
      }),
    );
  }

  public async enqueueDeliveries(newsletterId: string, memberIds: string[]): Promise<void> {
    for (let index = 0; index < memberIds.length; index += 10) {
      const batch = memberIds.slice(index, index + 10);
      const result = await this.client.send(
        new SendMessageBatchCommand({
          Entries: batch.map((memberId) => ({
            Id: memberId,
            MessageBody: JSON.stringify({
              kind: 'newsletter_delivery',
              memberId,
              newsletterId,
            } satisfies NewsletterJob),
          })),
          QueueUrl: this.queueUrl,
        }),
      );
      if ((result.Failed?.length ?? 0) > 0) {
        throw new Error('SQS rejected one or more newsletter delivery jobs.');
      }
    }
  }
}

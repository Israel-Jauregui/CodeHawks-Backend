import type { Newsletter } from '../domain/entities.js';
import type { ClubRepository } from '../repositories/club-repository.js';
import type { NewsletterEmailSender } from './ses-email-sender.js';
import type { NewsletterJob, NewsletterQueue } from './newsletter-queue.js';

export class NewsletterWorker {
  public constructor(
    private readonly repository: ClubRepository,
    private readonly queue: NewsletterQueue,
    private readonly emailSender: NewsletterEmailSender,
  ) {}

  public async process(job: NewsletterJob): Promise<void> {
    if (job.kind === 'newsletter_fanout') {
      await this.fanout(job.newsletterId);
      return;
    }
    await this.deliver(job.newsletterId, job.memberId);
  }

  private async fanout(newsletterId: string): Promise<void> {
    const newsletter = await this.repository.getNewsletter(newsletterId);
    if (!newsletter) throw new Error('Newsletter metadata is missing.');
    if (newsletter.status !== 'queued') return;

    const memberIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.listNewsletterRecipients(100, cursor);
      memberIds.push(...page.items.map((member) => member.id));
      cursor = page.nextCursor;
    } while (cursor);

    await this.queue.enqueueDeliveries(newsletter.id, memberIds);
    await this.repository.markNewsletterFanout(newsletter.id, memberIds.length);
  }

  private async deliver(newsletterId: string, memberId: string): Promise<void> {
    const newsletter = await this.repository.getNewsletter(newsletterId);
    if (!newsletter) throw new Error('Newsletter metadata is missing.');
    if (newsletter.status === 'sent') return;
    const claimToken = await this.repository.claimNewsletterDelivery(newsletterId, memberId);
    if (!claimToken) return;

    let updated: Newsletter;
    let deliveryAttemptStarted = false;
    try {
      const recipient = await this.repository.getMember(memberId);
      if (!recipient || recipient.status !== 'active' || !recipient.newsletterOptIn) {
        updated = await this.repository.completeNewsletterDelivery(
          newsletterId,
          memberId,
          'skipped',
          claimToken,
        );
      } else {
        if (
          !(await this.repository.beginNewsletterDeliveryAttempt(
            newsletterId,
            memberId,
            claimToken,
          ))
        ) {
          throw new Error('The newsletter delivery lease expired or changed before send.');
        }
        deliveryAttemptStarted = true;
        const providerMessageId = await this.emailSender.sendNewsletter(newsletter, recipient);
        updated = await this.repository.completeNewsletterDelivery(
          newsletterId,
          memberId,
          'sent',
          claimToken,
          providerMessageId,
        );
      }
    } catch (error) {
      if (!deliveryAttemptStarted) {
        await this.repository.releaseNewsletterDeliveryClaim(
          newsletterId,
          memberId,
          claimToken,
        );
      }
      throw error;
    }

    if (
      updated.status === 'sending' &&
      updated.fanoutComplete &&
      updated.processedCount >= updated.recipientCount
    ) {
      await this.repository.updateNewsletterStatus(newsletterId, 'sending', 'sent');
    }
  }
}

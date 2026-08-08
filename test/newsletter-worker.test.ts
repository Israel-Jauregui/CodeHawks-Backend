import { describe, expect, it, vi } from 'vitest';
import type { Member, Newsletter } from '../src/domain/entities.js';
import type { NewsletterQueue } from '../src/email/newsletter-queue.js';
import { NewsletterWorker } from '../src/email/newsletter-worker.js';
import type { NewsletterEmailSender } from '../src/email/ses-email-sender.js';
import type { ClubRepository } from '../src/repositories/club-repository.js';

const member: Member = {
  createdAt: '2026-01-01T00:00:00.000Z',
  displayName: 'Ada',
  email: 'ada@ung.edu',
  handle: 'ada',
  id: '11111111-1111-4111-8111-111111111111',
  identityProvider: 'entra',
  identitySubject: 'entra-object-id',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
  role: 'member',
  status: 'active',
  techStack: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const newsletter: Newsletter = {
  body: 'Hello!',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: '22222222-2222-4222-8222-222222222222',
  createdByHandle: 'officer',
  fanoutComplete: false,
  id: '33333333-3333-4333-8333-333333333333',
  processedCount: 0,
  recipientCount: 0,
  sentCount: 0,
  skippedCount: 0,
  status: 'queued',
  subject: 'Update',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('NewsletterWorker', () => {
  it('fans a queued newsletter out to every active recipient returned by the index', async () => {
    const enqueueDeliveries = vi.fn().mockResolvedValue(undefined);
    const markNewsletterFanout = vi.fn().mockResolvedValue({
      ...newsletter,
      fanoutComplete: true,
      recipientCount: 1,
      status: 'sending',
    });
    const repository = {
      getNewsletter: vi.fn().mockResolvedValue(newsletter),
      listNewsletterRecipients: vi.fn().mockResolvedValue({ items: [member] }),
      markNewsletterFanout,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      { enqueueDeliveries } as unknown as NewsletterQueue,
      {} as NewsletterEmailSender,
    );

    await worker.process({ kind: 'newsletter_fanout', newsletterId: newsletter.id });

    expect(enqueueDeliveries).toHaveBeenCalledWith(newsletter.id, [member.id]);
    expect(markNewsletterFanout).toHaveBeenCalledWith(newsletter.id, 1);
  });

  it('sends one email and completes the newsletter after the last delivery', async () => {
    const sendingNewsletter: Newsletter = {
      ...newsletter,
      fanoutComplete: true,
      recipientCount: 1,
      status: 'sending',
    };
    const sendNewsletter = vi.fn().mockResolvedValue(undefined);
    const updateNewsletterStatus = vi.fn().mockResolvedValue({
      ...sendingNewsletter,
      processedCount: 1,
      sentCount: 1,
      status: 'sent',
    });
    const repository = {
      getMember: vi.fn().mockResolvedValue(member),
      getNewsletter: vi.fn().mockResolvedValue(sendingNewsletter),
      hasNewsletterDelivery: vi.fn().mockResolvedValue(false),
      recordNewsletterDelivery: vi.fn().mockResolvedValue({
        ...sendingNewsletter,
        processedCount: 1,
        sentCount: 1,
      }),
      updateNewsletterStatus,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      {} as NewsletterQueue,
      { sendNewsletter },
    );

    await worker.process({
      kind: 'newsletter_delivery',
      memberId: member.id,
      newsletterId: newsletter.id,
    });

    expect(sendNewsletter).toHaveBeenCalledWith(sendingNewsletter, member);
    expect(updateNewsletterStatus).toHaveBeenCalledWith(newsletter.id, 'sending', 'sent');
  });
});

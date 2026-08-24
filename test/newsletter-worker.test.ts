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
  isPublicProfile: false,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  minors: [],
  newsletterOptIn: true,
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
    const sendNewsletter = vi.fn().mockResolvedValue('ses-message-id');
    const completeNewsletterDelivery = vi.fn().mockResolvedValue({
      ...sendingNewsletter,
      processedCount: 1,
      sentCount: 1,
    });
    const updateNewsletterStatus = vi.fn().mockResolvedValue({
      ...sendingNewsletter,
      processedCount: 1,
      sentCount: 1,
      status: 'sent',
    });
    const repository = {
      beginNewsletterDeliveryAttempt: vi.fn().mockResolvedValue(true),
      claimNewsletterDelivery: vi.fn().mockResolvedValue('claim-token'),
      completeNewsletterDelivery,
      getMember: vi.fn().mockResolvedValue(member),
      getNewsletter: vi.fn().mockResolvedValue(sendingNewsletter),
      releaseNewsletterDeliveryClaim: vi.fn().mockResolvedValue(undefined),
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
    expect(completeNewsletterDelivery).toHaveBeenCalledWith(
      newsletter.id,
      member.id,
      'sent',
      'claim-token',
      'ses-message-id',
    );
    expect(updateNewsletterStatus).toHaveBeenCalledWith(newsletter.id, 'sending', 'sent');
  });

  it('does not process a duplicate delivery that lost the conditional claim race', async () => {
    const getMember = vi.fn();
    const sendNewsletter = vi.fn();
    const repository = {
      claimNewsletterDelivery: vi.fn().mockResolvedValue(undefined),
      getMember,
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        status: 'sending',
      }),
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

    expect(getMember).not.toHaveBeenCalled();
    expect(sendNewsletter).not.toHaveBeenCalled();
  });

  it('rechecks newsletter consent immediately before delivery', async () => {
    const optedOutMember = { ...member, newsletterOptIn: false };
    const completeNewsletterDelivery = vi.fn().mockResolvedValue({
      ...newsletter,
      fanoutComplete: true,
      processedCount: 1,
      recipientCount: 1,
      skippedCount: 1,
      status: 'sending',
    });
    const sendNewsletter = vi.fn();
    const repository = {
      claimNewsletterDelivery: vi.fn().mockResolvedValue('claim-token'),
      completeNewsletterDelivery,
      getMember: vi.fn().mockResolvedValue(optedOutMember),
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        recipientCount: 1,
        status: 'sending',
      }),
      releaseNewsletterDeliveryClaim: vi.fn(),
      updateNewsletterStatus: vi.fn().mockResolvedValue({ ...newsletter, status: 'sent' }),
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

    expect(sendNewsletter).not.toHaveBeenCalled();
    expect(completeNewsletterDelivery).toHaveBeenCalledWith(
      newsletter.id,
      member.id,
      'skipped',
      'claim-token',
    );
  });

  it('keeps the claim when SES accepted but completion recording fails', async () => {
    const releaseNewsletterDeliveryClaim = vi.fn();
    const repository = {
      beginNewsletterDeliveryAttempt: vi.fn().mockResolvedValue(true),
      claimNewsletterDelivery: vi.fn().mockResolvedValue('claim-token'),
      completeNewsletterDelivery: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
      getMember: vi.fn().mockResolvedValue(member),
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        recipientCount: 1,
        status: 'sending',
      }),
      releaseNewsletterDeliveryClaim,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      {} as NewsletterQueue,
      { sendNewsletter: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(
      worker.process({
        kind: 'newsletter_delivery',
        memberId: member.id,
        newsletterId: newsletter.id,
      }),
    ).rejects.toThrow('DynamoDB unavailable');
    expect(releaseNewsletterDeliveryClaim).not.toHaveBeenCalled();
  });

  it('releases an owned claim when processing fails before the send attempt starts', async () => {
    const releaseNewsletterDeliveryClaim = vi.fn().mockResolvedValue(undefined);
    const repository = {
      claimNewsletterDelivery: vi.fn().mockResolvedValue('claim-token'),
      getMember: vi.fn().mockRejectedValue(new Error('profile read failed')),
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        recipientCount: 1,
        status: 'sending',
      }),
      releaseNewsletterDeliveryClaim,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      {} as NewsletterQueue,
      { sendNewsletter: vi.fn() },
    );

    await expect(
      worker.process({
        kind: 'newsletter_delivery',
        memberId: member.id,
        newsletterId: newsletter.id,
      }),
    ).rejects.toThrow('profile read failed');
    expect(releaseNewsletterDeliveryClaim).toHaveBeenCalledWith(
      newsletter.id,
      member.id,
      'claim-token',
    );
  });

  it('fails the SQS receipt when its lease expires before the provider attempt', async () => {
    const releaseNewsletterDeliveryClaim = vi.fn().mockResolvedValue(undefined);
    const sendNewsletter = vi.fn();
    const repository = {
      beginNewsletterDeliveryAttempt: vi.fn().mockResolvedValue(false),
      claimNewsletterDelivery: vi.fn().mockResolvedValue('stale-claim-token'),
      getMember: vi.fn().mockResolvedValue(member),
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        recipientCount: 1,
        status: 'sending',
      }),
      releaseNewsletterDeliveryClaim,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      {} as NewsletterQueue,
      { sendNewsletter },
    );

    await expect(
      worker.process({
        kind: 'newsletter_delivery',
        memberId: member.id,
        newsletterId: newsletter.id,
      }),
    ).rejects.toThrow('lease expired or changed');
    expect(sendNewsletter).not.toHaveBeenCalled();
    expect(releaseNewsletterDeliveryClaim).toHaveBeenCalledWith(
      newsletter.id,
      member.id,
      'stale-claim-token',
    );
  });

  it('never releases or automatically retries after the provider-attempt boundary', async () => {
    const releaseNewsletterDeliveryClaim = vi.fn();
    const sendNewsletter = vi.fn().mockRejectedValue(new Error('SES timeout'));
    const repository = {
      beginNewsletterDeliveryAttempt: vi.fn().mockResolvedValue(true),
      claimNewsletterDelivery: vi.fn().mockResolvedValue('claim-token'),
      getMember: vi.fn().mockResolvedValue(member),
      getNewsletter: vi.fn().mockResolvedValue({
        ...newsletter,
        fanoutComplete: true,
        recipientCount: 1,
        status: 'sending',
      }),
      releaseNewsletterDeliveryClaim,
    } as unknown as ClubRepository;
    const worker = new NewsletterWorker(
      repository,
      {} as NewsletterQueue,
      { sendNewsletter },
    );

    await expect(
      worker.process({
        kind: 'newsletter_delivery',
        memberId: member.id,
        newsletterId: newsletter.id,
      }),
    ).rejects.toThrow('SES timeout');
    expect(releaseNewsletterDeliveryClaim).not.toHaveBeenCalled();
  });
});

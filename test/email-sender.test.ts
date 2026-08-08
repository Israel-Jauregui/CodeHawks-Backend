import type { SendEmailCommandInput, SESv2Client } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import type { Member, Newsletter } from '../src/domain/entities.js';
import { SesNewsletterEmailSender } from '../src/email/ses-email-sender.js';

describe('SesNewsletterEmailSender', () => {
  it('sends to one server-selected recipient and escapes officer-authored HTML', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'message-id' });
    const sender = new SesNewsletterEmailSender(
      'CodeHawks <noreply@codehawks.org>',
      'officers@codehawks.org',
      'codehawks-production',
      { send } as unknown as SESv2Client,
    );
    const recipient = {
      email: 'member@ung.edu',
      status: 'active',
    } as Member;
    const newsletter = {
      body: '<script>alert(1)</script>',
      createdByHandle: 'president',
      subject: 'Club update',
    } as Newsletter;

    await sender.sendNewsletter(newsletter, recipient);

    const command = send.mock.calls[0]?.[0] as { input: SendEmailCommandInput };
    expect(command.input.Destination?.ToAddresses).toEqual(['member@ung.edu']);
    expect(command.input.Content?.Simple?.Body?.Html?.Data).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(command.input.Content?.Simple?.Body?.Html?.Data).not.toContain('<script>');
  });
});

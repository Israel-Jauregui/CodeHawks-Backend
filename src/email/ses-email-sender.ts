import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { Member, Newsletter } from '../domain/entities.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export interface NewsletterEmailSender {
  sendNewsletter(newsletter: Newsletter, recipient: Member): Promise<void>;
}

export class SesNewsletterEmailSender implements NewsletterEmailSender {
  public constructor(
    private readonly fromAddress: string,
    private readonly replyToAddress: string | undefined,
    private readonly configurationSetName: string | undefined,
    private readonly client: SESv2Client = new SESv2Client({}),
  ) {}

  public async sendNewsletter(newsletter: Newsletter, recipient: Member): Promise<void> {
    const safeBody = escapeHtml(newsletter.body).replaceAll(/\r?\n/g, '<br>');
    const footer = `Sent by @${escapeHtml(newsletter.createdByHandle)} to active CodeHawks club members.`;

    await this.client.send(
      new SendEmailCommand({
        ...(this.configurationSetName
          ? { ConfigurationSetName: this.configurationSetName }
          : {}),
        Content: {
          Simple: {
            Body: {
              Html: {
                Charset: 'UTF-8',
                Data: `<div style="font-family:system-ui,sans-serif;line-height:1.5">${safeBody}<hr><small>${footer}</small></div>`,
              },
              Text: {
                Charset: 'UTF-8',
                Data: `${newsletter.body}\n\n---\nSent by @${newsletter.createdByHandle} to active CodeHawks club members.`,
              },
            },
            Subject: { Charset: 'UTF-8', Data: newsletter.subject },
          },
        },
        Destination: { ToAddresses: [recipient.email] },
        FromEmailAddress: this.fromAddress,
        ...(this.replyToAddress ? { ReplyToAddresses: [this.replyToAddress] } : {}),
      }),
    );
  }
}

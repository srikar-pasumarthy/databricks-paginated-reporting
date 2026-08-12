// Email delivery with a preview fallback.
//
// SMTP is configured from environment variables (injected from a Databricks
// secret scope at deploy time — never hard-coded):
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   SMTP_SECURE = "true" to use TLS on connect (port 465); otherwise STARTTLS.
//
// If SMTP_HOST / SMTP_FROM are absent, the mailer runs in PREVIEW mode: it does
// not throw and does not attempt a connection — it just reports that the send
// was previewed (so the whole schedule → render → "send" loop is fully
// demoable before any credentials exist). Dropping the secrets in flips it to
// real delivery with no code change.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

export type MailResult = { status: 'sent'; messageId?: string } | { status: 'preview' };

/** True when real SMTP credentials are present. */
export function mailerConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

let cachedTransport: Transporter | null = null;

function transport(): Transporter {
  if (cachedTransport) return cachedTransport;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  return cachedTransport;
}

/**
 * Send a message. In preview mode this is a no-op that returns { status:
 * 'preview' }; the caller is responsible for logging the attempt. Throws only
 * on a real SMTP failure (so the caller can record 'failed').
 */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
  if (!mailerConfigured()) {
    console.log(
      `[mailer] PREVIEW (no SMTP configured) → would send "${msg.subject}" to ${msg.to.join(', ')} ` +
        `with ${msg.attachments.length} attachment(s)`,
    );
    return { status: 'preview' };
  }

  // @types/nodemailer types SentMessageInfo as `any`; capture it as unknown and
  // read messageId defensively so we stay free of unsafe-any.
  const info: unknown = await transport().sendMail({
    from: process.env.SMTP_FROM,
    to: msg.to.join(', '),
    subject: msg.subject,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  const messageId =
    typeof info === 'object' && info !== null && 'messageId' in info
      ? String((info as { messageId: unknown }).messageId)
      : undefined;
  return { status: 'sent', messageId };
}

/**
 * Pluggable email transport.
 *
 * The PasswordResetService talks through `EmailSender`, so swapping
 * the dev console logger for Resend (or SES, SendGrid, …) later is a
 * one-line change at boot time.
 *
 * Phase B3 ships two implementations:
 *   - `ConsoleEmailSender` — prints the message to the server log,
 *     used in tests and any deployment without RESEND_API_KEY set.
 *   - `ResendEmailSender` — posts to https://api.resend.com/emails
 *     when RESEND_API_KEY is configured.
 *
 * `resolveEmailSender()` picks the right one based on env vars.
 */

import { logger } from '../util/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. HTML is optional. */
  text: string;
  html?: string;
  /** RFC-5322 "From: ..." header value. Falls back to the sender's
   *  configured default if omitted. */
  from?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
  readonly kind: 'console' | 'resend';
}

export class ConsoleEmailSender implements EmailSender {
  readonly kind = 'console' as const;

  async send(msg: EmailMessage): Promise<void> {
    // The reset endpoint deliberately never returns the token in its
    // HTTP response, so in dev / unkeyed prod the server log is the
    // only place a developer can grab it from. Log the entire body.
    logger.info(
      { to: msg.to, subject: msg.subject, body: msg.text },
      '[email/console] would have sent the following message',
    );
  }
}

export interface ResendOptions {
  apiKey: string;
  defaultFrom: string;
}

export class ResendEmailSender implements EmailSender {
  readonly kind = 'resend' as const;

  constructor(private readonly opts: ResendOptions) {}

  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: msg.from ?? this.opts.defaultFrom,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }
}

/**
 * Pick the email transport at boot. We default to ConsoleEmailSender
 * — it's the only one that works without external credentials and is
 * the right answer in every test environment.
 *
 * Production with `RESEND_API_KEY` set automatically upgrades to
 * `ResendEmailSender`. The `EMAIL_FROM` env var customises the From:
 * header; it falls back to a noreply identity on the same default
 * domain Resend exposes (`onboarding@resend.dev`) so the server still
 * boots if the operator forgot to set it.
 */
export function resolveEmailSender(): EmailSender {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return new ConsoleEmailSender();
  return new ResendEmailSender({
    apiKey: key,
    defaultFrom: process.env.EMAIL_FROM ?? 'ChainDrop <onboarding@resend.dev>',
  });
}

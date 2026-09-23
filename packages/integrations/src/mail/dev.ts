import { createHash } from 'node:crypto';
import {
  formatMailAddress,
  SmtpMailProvider,
  validateMailMessage,
  type SmtpConfigInput,
  type SmtpDeps,
} from './smtp';
import type {
  MailAddress,
  MailMessage,
  MailProvider,
  MailProviderDescription,
  MailSendResult,
  MailVerifyResult,
} from './types';

/**
 * Labelled development mail adapter. Messages are kept in memory (`outbox`)
 * for tests and the development UI. When `forward` is configured (Mailpit on
 * localhost, which requires `allowPrivate`), each message is also handed to
 * the SMTP adapter so it shows up at http://localhost:8025. Refuses production.
 */

export interface DevMailOptions {
  nodeEnv?: string;
  /** Optional Mailpit-style SMTP sink; must have `allowPrivate: true`. */
  forward?: SmtpConfigInput | null;
  from?: MailAddress;
  deps?: SmtpDeps;
  now?: () => Date;
}

export interface DevMailRecord {
  id: string;
  to: MailAddress[];
  from: MailAddress;
  replyTo: MailAddress | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  tags: string[];
  idempotencyKey: string;
  sentAt: Date;
  forwarded: MailSendResult | null;
}

export class DevMailProvider implements MailProvider {
  readonly id = 'dev' as const;
  private readonly records: DevMailRecord[] = [];
  private readonly byKey = new Map<string, MailSendResult>();
  private readonly forwarder: SmtpMailProvider | null;
  private readonly from: MailAddress;
  private readonly now: () => Date;

  constructor(options: DevMailOptions = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      throw new Error('The development mail adapter refuses to run in production');
    }
    if (options.forward) {
      if (!options.forward.allowPrivate) {
        throw new Error(
          'development mail forwarding requires allowPrivate: true (Mailpit on localhost)',
        );
      }
      this.forwarder = new SmtpMailProvider(options.forward, options.deps);
    } else {
      this.forwarder = null;
    }
    this.from = options.from ?? { email: 'no-reply@localhost', name: 'SimplexD (development)' };
    this.now = options.now ?? (() => new Date());
  }

  get outbox(): readonly DevMailRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
    this.byKey.clear();
  }

  describe(): MailProviderDescription {
    if (this.forwarder) return { ...this.forwarder.describe(), adapter: 'dev' };
    return {
      adapter: 'dev',
      host: 'in-memory',
      port: 0,
      security: 'none',
      username: 'not set',
      from: formatMailAddress(this.from),
      replyTo: null,
    };
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const cached = this.byKey.get(message.idempotencyKey);
    if (cached) return cached;
    const invalid = validateMailMessage(message);
    if (invalid) {
      return {
        accepted: false,
        providerMessageId: null,
        response: null,
        errorSanitized: invalid.message,
        errorCode: invalid.code,
        retryable: false,
      };
    }
    const id = `dev-mail-${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 16)}`;
    const record: DevMailRecord = {
      id,
      to: message.to,
      from: message.from,
      replyTo: message.replyTo ?? null,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { ...(message.headers ?? {}) },
      tags: [...(message.tags ?? [])],
      idempotencyKey: message.idempotencyKey,
      sentAt: this.now(),
      forwarded: null,
    };
    this.records.push(record);
    let result: MailSendResult;
    if (this.forwarder) {
      const forwarded = await this.forwarder.send(message);
      record.forwarded = forwarded;
      result = { ...forwarded, providerMessageId: forwarded.providerMessageId ?? id };
    } else {
      result = {
        accepted: true,
        providerMessageId: id,
        response: 'stored in the development outbox (not sent)',
        retryable: false,
      };
    }
    this.byKey.set(message.idempotencyKey, result);
    return result;
  }

  async verifyConnection(): Promise<MailVerifyResult> {
    if (this.forwarder) return this.forwarder.verifyConnection();
    return {
      ok: true,
      message: 'Development mail adapter: messages are stored in memory and never sent',
      tls: 'none',
      latencyMs: 0,
    };
  }
}

export function createDevMailProvider(options: DevMailOptions = {}): DevMailProvider {
  return new DevMailProvider(options);
}

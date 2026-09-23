import { createHash } from 'node:crypto';
import { normalizeToE164, toTermiiFormat } from './phone';
import { analyzeSegments, type SmsEncoding } from './segments';
import {
  getHeader,
  parseTermiiJson,
  parseTermiiWebhookPayload,
  signTermiiPayload,
  TERMII_SIGNATURE_HEADER,
  verifyTermiiSignature,
} from './termii';
import type {
  ProviderOtpSendInput,
  ProviderOtpSendResult,
  ProviderOtpVerifyResult,
  SenderIdListResult,
  SenderIdRequestInput,
  SenderIdRequestResult,
  SmsBalanceResult,
  SmsBulkRecipientResult,
  SmsBulkSendInput,
  SmsCategory,
  SmsChannel,
  SmsConnectionTestResult,
  SmsDeliveryState,
  SmsDeliveryWebhookEvent,
  SmsMessageStatus,
  SmsProvider,
  SmsProviderDescription,
  SmsSendInput,
  SmsSendResult,
  WebhookHeaders,
} from './types';

/**
 * Labelled development SMS adapter. Nothing leaves the process: messages are
 * kept in memory (`outbox`) for tests and the development UI, message ids are
 * deterministic per idempotency key, and delivery receipts can be simulated
 * as signed Termii-shaped webhooks so the whole pipeline can be exercised.
 *
 * Deterministic behaviour by recipient suffix (last four digits):
 * - `0000`: the provider rejects the send (accepted = false);
 * - `1111`: accepted, later reported `Message Failed`;
 * - `2222`: accepted, later reported `DND Active on Phone Number` (rejected);
 * - anything else: accepted and delivered.
 *
 * Refuses to run in production.
 */

export const DEV_SMS_WEBHOOK_SECRET = 'dev-termii-webhook-secret';

export interface DevSmsOptions {
  /** Only `test` is accepted; the dev adapter never speaks to a live route. */
  environment?: 'test';
  nodeEnv?: string;
  senderId?: string;
  webhookSecret?: string;
  now?: () => Date;
}

export interface DevSmsRecord {
  id: string;
  to: string;
  from: string;
  body: string;
  category: SmsCategory;
  channel: SmsChannel;
  idempotencyKey: string;
  segments: number;
  encoding: SmsEncoding;
  sentAt: Date;
  deliveryState: SmsDeliveryState;
  providerStatus: string;
}

export interface SimulatedReceipt {
  rawBody: string;
  headers: Record<string, string>;
}

const SIMULATED_STATUS: Record<SmsDeliveryState, string> = {
  delivered: 'DELIVERED | Message delivered to handset',
  failed: 'Message Failed',
  rejected: 'DND Active on Phone Number',
  expired: 'Expired',
  sent: 'Message Sent',
  unknown: 'Unknown',
};

function deterministicId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export class DevSmsProvider implements SmsProvider {
  readonly id = 'dev' as const;
  readonly environment = 'test' as const;
  private readonly records: DevSmsRecord[] = [];
  private readonly byKey = new Map<string, SmsSendResult>();
  private readonly pins = new Map<string, { code: string; attempts: number; expiresAt: number }>();
  private readonly senderId: string;
  private readonly webhookSecret: string;
  private readonly now: () => Date;

  constructor(options: DevSmsOptions = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      throw new Error('The development SMS adapter refuses to run in production');
    }
    if (options.environment !== undefined && options.environment !== 'test') {
      throw new Error('The development SMS adapter only supports the test environment');
    }
    this.senderId = options.senderId ?? 'SimplexD';
    this.webhookSecret = options.webhookSecret ?? DEV_SMS_WEBHOOK_SECRET;
    this.now = options.now ?? (() => new Date());
  }

  get outbox(): readonly DevSmsRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
    this.byKey.clear();
    this.pins.clear();
  }

  describe(): SmsProviderDescription {
    return {
      adapter: 'dev',
      environment: 'test',
      baseUrl: null,
      senderId: this.senderId,
      apiKeyMasked: 'not required (development adapter)',
      webhookSecretConfigured: true,
    };
  }

  private simulatedState(e164: string): SmsDeliveryState | 'reject_send' {
    const tail = e164.slice(-4);
    if (tail === '0000') return 'reject_send';
    if (tail === '1111') return 'failed';
    if (tail === '2222') return 'rejected';
    return 'delivered';
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const phone = normalizeToE164(input.to);
    if (!phone.ok) {
      return {
        accepted: false,
        providerMessageId: null,
        providerStatus: null,
        errorSanitized: `invalid recipient phone number (${phone.reason})`,
        retryable: false,
      };
    }
    const state = this.simulatedState(phone.e164);
    if (state === 'reject_send') {
      const rejected: SmsSendResult = {
        accepted: false,
        providerMessageId: null,
        providerStatus: 'Invalid Sender Id',
        errorSanitized: 'simulated provider rejection (recipient ends in 0000)',
        retryable: false,
      };
      this.byKey.set(input.idempotencyKey, rejected);
      return rejected;
    }
    const estimate = analyzeSegments(input.body);
    const id = deterministicId('dev-sms', input.idempotencyKey);
    this.records.push({
      id,
      to: phone.e164,
      from: input.from,
      body: input.body,
      category: input.category,
      channel: input.channel ?? (input.category === 'marketing' ? 'generic' : 'dnd'),
      idempotencyKey: input.idempotencyKey,
      segments: estimate.segments,
      encoding: estimate.encoding,
      sentAt: this.now(),
      deliveryState: state,
      providerStatus: SIMULATED_STATUS[state],
    });
    const result: SmsSendResult = {
      accepted: true,
      providerMessageId: id,
      providerStatus: 'Successfully Sent',
      balance: Math.max(0, 10_000 - this.records.reduce((sum, r) => sum + r.segments, 0)),
      retryable: false,
    };
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  async sendBulk(input: SmsBulkSendInput): Promise<SmsBulkRecipientResult[]> {
    const out: SmsBulkRecipientResult[] = [];
    for (const [index, to] of input.to.entries()) {
      const result = await this.send({
        ...input,
        to,
        idempotencyKey: `${input.idempotencyKey}:${index}`,
      });
      out.push({ to, ...result });
    }
    return out;
  }

  async getBalance(): Promise<SmsBalanceResult> {
    return {
      ok: true,
      balance: Math.max(0, 10_000 - this.records.reduce((sum, r) => sum + r.segments, 0)),
      currency: 'NGN',
    };
  }

  async listSenderIds(): Promise<SenderIdListResult> {
    return {
      ok: true,
      senderIds: [
        {
          senderId: this.senderId,
          status: 'active',
          approval: 'approved',
          company: 'SimplexD (development)',
          useCase: 'Transactional notifications',
          country: 'NG',
          createdAt: this.now().toISOString(),
        },
      ],
    };
  }

  async requestSenderId(input: SenderIdRequestInput): Promise<SenderIdRequestResult> {
    return {
      ok: true,
      message: `Sender ID request for "${input.senderId}" recorded by the development adapter (no provider call)`,
    };
  }

  async getMessageStatus(providerMessageId: string): Promise<SmsMessageStatus> {
    const record = this.records.find((r) => r.id === providerMessageId);
    if (!record) {
      return {
        found: false,
        providerMessageId,
        deliveryState: 'unknown',
        providerStatus: null,
        recipient: null,
        cost: null,
        occurredAt: null,
      };
    }
    return {
      found: true,
      providerMessageId,
      deliveryState: record.deliveryState,
      providerStatus: record.providerStatus,
      recipient: record.to,
      cost: record.segments * 4,
      occurredAt: record.sentAt,
    };
  }

  /** Builds a signed, Termii-shaped outbound delivery report for a recorded message. */
  simulateDeliveryReceipt(
    providerMessageId: string,
    override?: SmsDeliveryState,
  ): SimulatedReceipt | null {
    const record = this.records.find((r) => r.id === providerMessageId);
    if (!record) return null;
    const state = override ?? record.deliveryState;
    if (override) {
      record.deliveryState = override;
      record.providerStatus = SIMULATED_STATUS[override];
    }
    const payload = {
      type: 'outbound',
      message_id: record.id,
      message_id_str: record.id,
      receiver: toTermiiFormat(record.to),
      sender: record.from,
      message: record.body,
      sent_at: record.sentAt.toISOString(),
      cost: String(record.segments * 4),
      pages: String(record.segments),
      command: 'deliver',
      status: SIMULATED_STATUS[state],
      channel: record.channel.toUpperCase(),
      messagestate: state,
      notify_id: record.id,
    };
    const rawBody = JSON.stringify(payload);
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [TERMII_SIGNATURE_HEADER]: signTermiiPayload(rawBody, this.webhookSecret),
      },
    };
  }

  /** Builds a signed inbound (reply) webhook, e.g. a STOP keyword from a customer. */
  simulateInbound(from: string, text: string): SimulatedReceipt | null {
    const phone = normalizeToE164(from);
    if (!phone.ok) return null;
    const rawBody = JSON.stringify({
      type: 'inbound',
      id: deterministicId('dev-in', `${from}:${text}:${this.now().getTime()}`),
      message_id: deterministicId('dev-in-msg', `${from}:${text}`),
      receiver: '2340000000000',
      sender: toTermiiFormat(phone.e164),
      message: text,
      received_at: this.now().toISOString(),
      cost: null,
      command: 'Received',
      status: 'Received',
      channel: null,
    });
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [TERMII_SIGNATURE_HEADER]: signTermiiPayload(rawBody, this.webhookSecret),
      },
    };
  }

  verifyWebhookSignature(
    rawBody: string | Buffer,
    header: string | string[] | null | undefined,
    secret: string,
  ): boolean {
    return verifyTermiiSignature(rawBody, header, secret);
  }

  parseDeliveryWebhook(rawBody: string | Buffer, headers: WebhookHeaders): SmsDeliveryWebhookEvent {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const event = parseTermiiWebhookPayload(parseTermiiJson(text));
    const signature = verifyTermiiSignature(
      rawBody,
      getHeader(headers, TERMII_SIGNATURE_HEADER),
      this.webhookSecret,
    )
      ? 'valid'
      : 'invalid';
    return { ...event, signature };
  }

  async testConnection(): Promise<SmsConnectionTestResult> {
    const balance = await this.getBalance();
    return {
      ok: true,
      message:
        'Development SMS adapter: messages are stored in memory and never sent to a carrier',
      latencyMs: 0,
      balance: balance.balance,
      currency: balance.currency,
      senderIdApproval: 'approved',
    };
  }

  async sendProviderOtp(input: ProviderOtpSendInput): Promise<ProviderOtpSendResult> {
    const phone = normalizeToE164(input.to);
    if (!phone.ok) {
      return { ok: false, pinId: null, providerStatus: null, errorSanitized: 'invalid recipient' };
    }
    const pinId = deterministicId('dev-pin', `${phone.e164}:${this.pins.size}`);
    // Fixed code for local testing only; the development adapter never runs in production.
    const code = '123456'.slice(0, input.pinLength ?? 6).padEnd(input.pinLength ?? 6, '0');
    this.pins.set(pinId, {
      code,
      attempts: 0,
      expiresAt: this.now().getTime() + (input.ttlMinutes ?? 10) * 60_000,
    });
    return { ok: true, pinId, providerStatus: 'Message Sent' };
  }

  async verifyProviderOtp(pinId: string, pin: string): Promise<ProviderOtpVerifyResult> {
    const entry = this.pins.get(pinId);
    if (!entry) return { ok: false, status: 'invalid' };
    if (this.now().getTime() > entry.expiresAt) return { ok: false, status: 'expired' };
    entry.attempts += 1;
    if (entry.code === pin.trim()) {
      this.pins.delete(pinId);
      return { ok: true, status: 'verified' };
    }
    return { ok: false, status: 'invalid' };
  }
}

export function createDevSmsProvider(options: DevSmsOptions = {}): DevSmsProvider {
  return new DevSmsProvider(options);
}

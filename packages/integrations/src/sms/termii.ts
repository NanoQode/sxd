import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { checkUrlDestination, hostAllowed, type DestinationCheck } from '../net/ssrf';
import { fingerprintSecret, maskSecretPresence } from '../secrets/envelope';
import { fromTermiiFormat, normalizeToE164, toTermiiFormat } from './phone';
import type {
  ProviderOtpSendInput,
  ProviderOtpSendResult,
  ProviderOtpVerifyResult,
  SenderIdApprovalState,
  SenderIdListResult,
  SenderIdRecord,
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
  SmsEnvironment,
  SmsMessageStatus,
  SmsProvider,
  SmsProviderDescription,
  SmsSendInput,
  SmsSendResult,
  SmsWebhookEventType,
  WebhookHeaders,
} from './types';

/**
 * Termii adapter.
 *
 * Source of truth: docs/providers/research/paystack-termii-research-2026-09-23.md
 * PART B. The official documentation site was unreachable when this was
 * written, so items marked UNVERIFIED below were taken from search snippets
 * of the official pages or from third-party SDKs and must be confirmed against
 * the Termii dashboard/sandbox before go-live. See docs/providers/termii.md.
 *
 * Verified from official snippets: base URL is account-specific; `api_key`
 * travels in the JSON body (POST) or query string (GET); `POST /api/sms/send`
 * fields and success shape; bulk endpoint with a `to` array; balance,
 * sender-id, history and OTP endpoints; `X-Termii-Signature` = HMAC-SHA512
 * of the payload; inbound webhook sample.
 *
 * Security properties: the API key never appears in errors, results or
 * thrown messages (see `sanitize`); the base URL must be https, credential
 * free and in the host allow-list; the resolved address is checked against
 * the SSRF policy before the first request.
 */

export const TERMII_DEFAULT_BASE_URL = 'https://v3.api.termii.com';
/** Legacy Nigeria host; still valid for older accounts (UNVERIFIED which accounts). */
export const TERMII_LEGACY_BASE_URL = 'https://api.ng.termii.com';
export const TERMII_KNOWN_BASE_URLS = [TERMII_DEFAULT_BASE_URL, TERMII_LEGACY_BASE_URL] as const;
export const TERMII_DEFAULT_ALLOWED_HOSTS = ['.termii.com'];
/** UNVERIFIED: the docs historically say `to` takes at most 100 numbers per request. */
export const TERMII_BULK_CHUNK_SIZE = 100;
/** UNVERIFIED: sender IDs are described as 3–11 alphanumeric characters. */
export const TERMII_SENDER_ID_PATTERN = /^[A-Za-z0-9]{3,11}$/;
export const TERMII_SIGNATURE_HEADER = 'x-termii-signature';

export const termiiConfigSchema = z.object({
  apiKey: z.string().min(8, 'API key looks too short'),
  /** Copied from the Termii dashboard; account-specific. */
  baseUrl: z.string().min(1).default(TERMII_DEFAULT_BASE_URL),
  senderId: z.string().regex(TERMII_SENDER_ID_PATTERN, 'sender ID must be 3–11 letters or digits'),
  environment: z.enum(['test', 'live']),
  /**
   * Secret used to verify `X-Termii-Signature`. UNVERIFIED which dashboard
   * value Termii signs with (community SDKs use the API key); keep it a
   * separate field so the operator can paste whatever the webhook config page shows.
   */
  webhookSecret: z.string().min(8).nullable().default(null),
  /** SSRF allow-list for the base URL host. */
  allowedHosts: z.array(z.string()).default(TERMII_DEFAULT_ALLOWED_HOSTS),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  /** Zone assumed for zone-less timestamps such as `sent_at: "2022-08-02 11:30:11"` (UNVERIFIED). */
  webhookTimeZone: z.string().default('Africa/Lagos'),
});

export type TermiiConfigInput = z.input<typeof termiiConfigSchema>;
export type TermiiConfig = z.output<typeof termiiConfigSchema>;

export interface TermiiDeps {
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to the SSRF guard with DNS resolution. */
  destinationCheck?: (url: string, allowedHosts: string[]) => Promise<DestinationCheck>;
  now?: () => Date;
}

export type TermiiErrorCode = 'config' | 'destination' | 'network' | 'timeout' | 'http' | 'response';

export class TermiiError extends Error {
  constructor(
    readonly code: TermiiErrorCode,
    message: string,
    readonly retryable = false,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'TermiiError';
  }
}

type JsonRecord = Record<string, unknown>;

interface TermiiResponse {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
}

const ID_KEYS = 'message_id|id|pin_id|notify_id|origid';
const BIG_INT_ID = new RegExp(`"(${ID_KEYS})"\\s*:\\s*(\\d{15,})`, 'g');

/**
 * Termii message ids are 64-bit integers (`9122821270554876574`). A plain
 * JSON.parse would round them, so id-like numeric values are quoted first.
 */
export function parseTermiiJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed.replace(BIG_INT_ID, '"$1":"$2"'));
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Strips control characters without a control-character regex. */
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Removes secrets and `api_key=` fragments from any provider text before it is stored or shown. */
export function sanitizeTermiiText(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const variant of [secret, encodeURIComponent(secret)]) {
      out = out.split(variant).join('[redacted]');
    }
  }
  out = out.replace(/api_key["']?\s*[:=]\s*["']?[^"'&\s,}]+/gi, 'api_key=[redacted]');
  out = printable(out);
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
}

export function defaultChannelFor(category: SmsCategory): SmsChannel {
  // Official guidance: the generic route is for promotional traffic and does
  // not reach DND numbers; OTP/transactional traffic uses the DND route.
  return category === 'marketing' ? 'generic' : 'dnd';
}

export const TERMII_STATUS_RULES: ReadonlyArray<{ pattern: RegExp; state: SmsDeliveryState }> = [
  { pattern: /dnd\s*active|^rejected|^reject/i, state: 'rejected' },
  { pattern: /^expired|\bexpired$|^expire/i, state: 'expired' },
  { pattern: /fail|undeliver|not delivered/i, state: 'failed' },
  { pattern: /^delivered|\bdelivered\b|^delivrd/i, state: 'delivered' },
  { pattern: /^message sent|^sent\b|accepted|submitted|^queued|^pending|^enroute/i, state: 'sent' },
];

/** Maps raw Termii status strings (history API and webhooks) to the delivery state enum. */
export function mapTermiiStatus(raw: string | null | undefined): SmsDeliveryState {
  if (!raw) return 'unknown';
  const text = raw.trim();
  for (const rule of TERMII_STATUS_RULES) {
    if (rule.pattern.test(text)) return rule.state;
  }
  return 'unknown';
}

export function normalizeSenderIdStatus(raw: string | null | undefined): SenderIdApprovalState {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (['active', 'unblock', 'unblocked', 'approved', 'verified', 'enabled'].includes(text)) {
    return 'approved';
  }
  if (['pending', 'review', 'in review', 'processing', 'submitted'].includes(text)) return 'pending';
  if (['block', 'blocked', 'rejected', 'declined', 'disabled', 'suspended'].includes(text)) {
    return 'blocked';
  }
  return 'unknown';
}

export function signTermiiPayload(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha512', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
}

/**
 * Constant-time verification of `X-Termii-Signature` (HMAC-SHA512 of the raw
 * body, hex; base64 is accepted as a fallback because the encoding is UNVERIFIED).
 */
export function verifyTermiiSignature(
  rawBody: string | Buffer,
  header: string | string[] | null | undefined,
  secret: string,
): boolean {
  const provided = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!provided || !secret) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const digest = createHmac('sha512', secret).update(body).digest();
  let expected: Buffer;
  let actual: Buffer;
  if (/^[0-9a-fA-F]{128}$/.test(provided)) {
    expected = digest;
    actual = Buffer.from(provided.toLowerCase(), 'hex');
  } else if (/^[A-Za-z0-9+/]{86}==$/.test(provided)) {
    expected = digest;
    actual = Buffer.from(provided, 'base64');
  } else {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function getHeader(headers: WebhookHeaders, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first : null;
  }
  return null;
}

function phoneOrRaw(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const e164 = fromTermiiFormat(text);
  if (!e164) return text;
  const normalized = normalizeToE164(e164);
  return normalized.ok ? normalized.e164 : e164;
}

export function parseTermiiTimestamp(value: unknown, zone = 'Africa/Lagos'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value !== 'string') return null;
  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid) return iso.toJSDate();
  // `sent_at: "2022-08-02 11:30:11"` carries no zone; assume the account zone (UNVERIFIED).
  const sql = DateTime.fromSQL(value, { zone });
  if (sql.isValid) return sql.toJSDate();
  return null;
}

/**
 * Pure parser for the Termii webhook payload (without signature handling).
 * Keys on `message_id` (string), reads `status`/`messagestate`, treats `type`
 * loosely and ignores unknown fields — see research B.9.
 */
export function parseTermiiWebhookPayload(
  payload: unknown,
  options: { timeZone?: string } = {},
): Omit<SmsDeliveryWebhookEvent, 'signature'> {
  const zone = options.timeZone ?? 'Africa/Lagos';
  const rec = asRecord(payload);
  const unknownEvent: Omit<SmsDeliveryWebhookEvent, 'signature'> = {
    type: 'unknown',
    providerMessageId: null,
    recipient: null,
    deliveryState: 'unknown',
    providerStatus: null,
    occurredAt: null,
  };
  if (!rec) return unknownEvent;

  const typeRaw = (str(rec.type) ?? '').toLowerCase();
  const messageId =
    str(rec.message_id_str) ?? str(rec.message_id) ?? str(rec.origid) ?? str(rec.notify_id);
  const status = str(rec.status);
  const messageState = str(rec.messagestate);
  const channel = str(rec.channel);

  let type: SmsWebhookEventType = 'unknown';
  if (typeRaw === 'inbound' || typeRaw === 'incoming') type = 'inbound';
  else if (['outbound', 'delivery_report', 'dlr', 'outgoing'].includes(typeRaw)) type = 'outbound';
  else if (typeRaw === 'device_status') type = 'device_status';
  else if (messageId && (status || messageState) && rec.receiver !== undefined) type = 'outbound';

  switch (type) {
    case 'inbound':
      return {
        type,
        providerMessageId: messageId,
        recipient: phoneOrRaw(rec.receiver),
        sender: phoneOrRaw(rec.sender),
        inboundText: str(rec.message),
        deliveryState: 'unknown',
        providerStatus: status,
        occurredAt: parseTermiiTimestamp(rec.received_at ?? rec.sent_at, zone),
        channel,
      };
    case 'outbound': {
      let deliveryState = mapTermiiStatus(status);
      if (deliveryState === 'unknown') deliveryState = mapTermiiStatus(messageState);
      return {
        type,
        providerMessageId: messageId,
        recipient: phoneOrRaw(rec.receiver),
        deliveryState,
        providerStatus: status ?? messageState,
        occurredAt: parseTermiiTimestamp(rec.sent_at ?? rec.delivered_at ?? rec.updated_at, zone),
        channel,
      };
    }
    case 'device_status':
      return {
        type,
        providerMessageId: null,
        recipient: null,
        deliveryState: 'unknown',
        providerStatus: status,
        occurredAt: null,
        channel: str(rec.device_id) ?? str(rec.name),
      };
    default:
      return unknownEvent;
  }
}

/** Validates the admin-supplied base URL synchronously; DNS/SSRF checks happen before the first request. */
export function validateTermiiBaseUrl(baseUrl: string, allowedHosts: string[]): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new TermiiError('config', 'Termii base URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new TermiiError('config', 'Termii base URL must use https (http returns Unauthorized)');
  }
  if (url.username || url.password) {
    throw new TermiiError('config', 'Termii base URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new TermiiError('config', 'Termii base URL must not contain a query string or fragment');
  }
  if (!hostAllowed(url.hostname, allowedHosts)) {
    throw new TermiiError('config', `Termii base URL host ${url.hostname} is not in the allow-list`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const DESTINATION_TTL_MS = 10 * 60 * 1000;

export class TermiiSmsProvider implements SmsProvider {
  readonly id = 'termii' as const;
  readonly environment: SmsEnvironment;
  private readonly config: TermiiConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly destinationCheck: NonNullable<TermiiDeps['destinationCheck']>;
  private readonly now: () => Date;
  private destination: { checkedAt: number; promise: Promise<void> } | null = null;

  constructor(input: TermiiConfigInput, deps: TermiiDeps = {}) {
    const parsed = termiiConfigSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new TermiiError('config', `invalid Termii configuration: ${issues}`);
    }
    this.config = parsed.data;
    this.environment = parsed.data.environment;
    this.baseUrl = validateTermiiBaseUrl(this.config.baseUrl, this.config.allowedHosts);
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.destinationCheck =
      deps.destinationCheck ??
      ((url, allowedHosts) =>
        checkUrlDestination(url, { allowedHosts, allowedProtocols: ['https:'] }));
    this.now = deps.now ?? (() => new Date());
  }

  describe(): SmsProviderDescription {
    return {
      adapter: 'termii',
      environment: this.environment,
      baseUrl: this.baseUrl,
      senderId: this.config.senderId,
      apiKeyMasked: maskSecretPresence(null, fingerprintSecret(this.config.apiKey)),
      webhookSecretConfigured: Boolean(this.config.webhookSecret),
    };
  }

  private sanitize(text: string): string {
    return sanitizeTermiiText(text, [this.config.apiKey, this.config.webhookSecret]);
  }

  private async ensureDestination(): Promise<void> {
    const at = this.now().getTime();
    if (!this.destination || at - this.destination.checkedAt > DESTINATION_TTL_MS) {
      const promise = this.destinationCheck(this.baseUrl, this.config.allowedHosts).then(
        (result) => {
          if (!result.ok) {
            throw new TermiiError(
              'destination',
              `Termii base URL rejected by the destination policy: ${result.reason ?? 'blocked'}`,
            );
          }
        },
      );
      this.destination = { checkedAt: at, promise };
    }
    try {
      await this.destination.promise;
    } catch (err) {
      this.destination = null;
      throw err;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: JsonRecord; query?: Record<string, string> } = {},
  ): Promise<TermiiResponse> {
    await this.ensureDestination();
    const url = new URL(`${this.baseUrl}${path}`);
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    };
    if (method === 'GET') {
      url.searchParams.set('api_key', this.config.apiKey);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        url.searchParams.set(key, value);
      }
    } else {
      init.body = JSON.stringify({ api_key: this.config.apiKey, ...(options.body ?? {}) });
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), init);
      const text = await res.text();
      return { status: res.status, ok: res.ok, body: parseTermiiJson(text), text };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TermiiError(
          'timeout',
          `Termii request timed out after ${this.config.timeoutMs}ms`,
          true,
        );
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new TermiiError(
        'network',
        `network error contacting Termii: ${this.sanitize(message)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failureMessage(res: TermiiResponse): string {
    const rec = asRecord(res.body);
    const detail =
      str(rec?.message) ?? str(rec?.error) ?? str(rec?.msg) ?? (res.text ? res.text : null);
    const suffix = detail ? `: ${detail}` : '';
    let text: string;
    if (res.status === 401 || res.status === 403) {
      text = `Termii rejected the credentials (HTTP ${res.status}); check the API key, the account base URL (https only) and account status${suffix}`;
    } else if (res.status === 429) {
      text = `Termii rate limit reached (HTTP 429)${suffix}`;
    } else if (res.status >= 500) {
      text = `Termii server error (HTTP ${res.status})${suffix}`;
    } else if (res.status >= 400) {
      text = `Termii rejected the request (HTTP ${res.status})${suffix}`;
    } else {
      text = `unexpected Termii response (HTTP ${res.status})${suffix}`;
    }
    return this.sanitize(text);
  }

  private errorResult(err: unknown): SmsSendResult {
    if (err instanceof TermiiError) {
      return {
        accepted: false,
        providerMessageId: null,
        providerStatus: null,
        errorSanitized: this.sanitize(err.message),
        retryable: err.retryable,
      };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return {
      accepted: false,
      providerMessageId: null,
      providerStatus: null,
      errorSanitized: this.sanitize(message),
      retryable: false,
    };
  }

  private interpretSend(res: TermiiResponse): SmsSendResult {
    const rec = asRecord(res.body);
    const messageId = str(rec?.message_id_str) ?? str(rec?.message_id);
    const code = str(rec?.code);
    if (res.ok && (code === 'ok' || messageId)) {
      return {
        accepted: true,
        providerMessageId: messageId,
        providerStatus: str(rec?.message) ?? 'accepted',
        balance: num(rec?.balance),
        retryable: false,
      };
    }
    return {
      accepted: false,
      providerMessageId: null,
      providerStatus: str(rec?.message),
      balance: num(rec?.balance),
      errorSanitized: this.failureMessage(res),
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
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
    if (!input.body.trim()) {
      return {
        accepted: false,
        providerMessageId: null,
        providerStatus: null,
        errorSanitized: 'empty message body',
        retryable: false,
      };
    }
    try {
      const res = await this.request('POST', '/api/sms/send', {
        body: {
          to: toTermiiFormat(phone.e164),
          from: input.from,
          sms: input.body,
          type: input.messageType ?? 'plain',
          channel: input.channel ?? defaultChannelFor(input.category),
        },
      });
      return this.interpretSend(res);
    } catch (err) {
      return this.errorResult(err);
    }
  }

  async sendBulk(input: SmsBulkSendInput): Promise<SmsBulkRecipientResult[]> {
    const results = new Array<SmsBulkRecipientResult | null>(input.to.length).fill(null);
    const seen = new Map<string, number>();
    const valid: Array<{ index: number; digits: string }> = [];
    input.to.forEach((raw, index) => {
      const phone = normalizeToE164(raw);
      if (!phone.ok) {
        results[index] = {
          to: raw,
          accepted: false,
          providerMessageId: null,
          providerStatus: null,
          errorSanitized: `invalid recipient phone number (${phone.reason})`,
          retryable: false,
        };
        return;
      }
      if (seen.has(phone.e164)) {
        results[index] = {
          to: raw,
          accepted: false,
          providerMessageId: null,
          providerStatus: 'duplicate',
          errorSanitized: 'duplicate recipient in batch; sent once',
          retryable: false,
        };
        return;
      }
      seen.set(phone.e164, index);
      valid.push({ index, digits: toTermiiFormat(phone.e164) });
    });

    if (!input.body.trim()) {
      for (const { index } of valid) {
        results[index] = {
          to: input.to[index] ?? '',
          accepted: false,
          providerMessageId: null,
          providerStatus: null,
          errorSanitized: 'empty message body',
          retryable: false,
        };
      }
    } else {
      for (const group of chunk(valid, TERMII_BULK_CHUNK_SIZE)) {
        let result: SmsSendResult;
        try {
          const res = await this.request('POST', '/api/sms/send/bulk', {
            body: {
              to: group.map((g) => g.digits),
              from: input.from,
              sms: input.body,
              type: input.messageType ?? 'plain',
              channel: input.channel ?? defaultChannelFor(input.category),
            },
          });
          result = this.interpretSend(res);
        } catch (err) {
          result = this.errorResult(err);
        }
        for (const { index } of group) {
          results[index] = { to: input.to[index] ?? '', ...result };
        }
      }
    }
    return results.map(
      (r, index) =>
        r ?? {
          to: input.to[index] ?? '',
          accepted: false,
          providerMessageId: null,
          providerStatus: null,
          errorSanitized: 'not sent',
          retryable: false,
        },
    );
  }

  async getBalance(): Promise<SmsBalanceResult> {
    try {
      const res = await this.request('GET', '/api/get-balance');
      const rec = asRecord(res.body);
      const balance = num(rec?.balance);
      if (!res.ok || balance === null) {
        return {
          ok: false,
          balance,
          currency: str(rec?.currency),
          errorSanitized: this.failureMessage(res),
        };
      }
      return { ok: true, balance, currency: str(rec?.currency) };
    } catch (err) {
      return { ok: false, balance: null, currency: null, errorSanitized: this.errorText(err) };
    }
  }

  private errorText(err: unknown): string {
    return this.sanitize(err instanceof Error ? err.message : 'unknown error');
  }

  async listSenderIds(): Promise<SenderIdListResult> {
    try {
      const res = await this.request('GET', '/api/sender-id');
      const rec = asRecord(res.body);
      const rows = Array.isArray(res.body)
        ? res.body
        : Array.isArray(rec?.data)
          ? (rec.data as unknown[])
          : null;
      if (!res.ok || !rows) {
        return { ok: false, senderIds: [], errorSanitized: this.failureMessage(res) };
      }
      const senderIds: SenderIdRecord[] = [];
      for (const row of rows) {
        const item = asRecord(row);
        const senderId = str(item?.sender_id);
        if (!item || !senderId) continue;
        const status = str(item.status) ?? '';
        senderIds.push({
          senderId,
          status,
          approval: normalizeSenderIdStatus(status),
          company: str(item.company),
          useCase: str(item.usecase) ?? str(item.use_case),
          country: str(item.country),
          createdAt: str(item.created_at),
        });
      }
      return { ok: true, senderIds };
    } catch (err) {
      return { ok: false, senderIds: [], errorSanitized: this.errorText(err) };
    }
  }

  async requestSenderId(input: SenderIdRequestInput): Promise<SenderIdRequestResult> {
    if (!TERMII_SENDER_ID_PATTERN.test(input.senderId)) {
      return { ok: false, message: null, errorSanitized: 'sender ID must be 3–11 letters or digits' };
    }
    try {
      const res = await this.request('POST', '/api/sender-id/request', {
        body: {
          sender_id: input.senderId,
          // The docs disagree on the field name; send both (research B.5).
          use_case: input.useCase,
          usecase: input.useCase,
          company: input.company,
        },
      });
      const rec = asRecord(res.body);
      const message = str(rec?.message);
      if (!res.ok || (str(rec?.code) !== 'ok' && !message)) {
        return { ok: false, message, errorSanitized: this.failureMessage(res) };
      }
      return { ok: true, message: message ? this.sanitize(message) : null };
    } catch (err) {
      return { ok: false, message: null, errorSanitized: this.errorText(err) };
    }
  }

  async getMessageStatus(providerMessageId: string): Promise<SmsMessageStatus> {
    const base: SmsMessageStatus = {
      found: false,
      providerMessageId,
      deliveryState: 'unknown',
      providerStatus: null,
      recipient: null,
      cost: null,
      occurredAt: null,
    };
    try {
      const res = await this.request('GET', '/api/sms/inbox', {
        query: { message_id: providerMessageId },
      });
      if (!res.ok) return { ...base, errorSanitized: this.failureMessage(res) };
      const rec = asRecord(res.body);
      const rows: unknown[] = Array.isArray(res.body)
        ? res.body
        : Array.isArray(rec?.data)
          ? (rec.data as unknown[])
          : rec
            ? [rec]
            : [];
      const items = rows.map(asRecord).filter((r): r is JsonRecord => r !== null);
      const match =
        items.find(
          (item) =>
            str(item.message_id) === providerMessageId ||
            str(item.message_id_str) === providerMessageId,
        ) ?? (items.length === 1 ? items[0] : undefined);
      if (!match) return base;
      const status = str(match.status);
      return {
        found: true,
        providerMessageId,
        deliveryState: mapTermiiStatus(status),
        providerStatus: status,
        recipient: phoneOrRaw(match.receiver),
        cost: num(match.amount) ?? num(match.cost),
        occurredAt: parseTermiiTimestamp(
          match.updated_at ?? match.created_at ?? match.sent_at,
          this.config.webhookTimeZone,
        ),
      };
    } catch (err) {
      return { ...base, errorSanitized: this.errorText(err) };
    }
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
    const event = parseTermiiWebhookPayload(parseTermiiJson(text), {
      timeZone: this.config.webhookTimeZone,
    });
    let signature: SmsDeliveryWebhookEvent['signature'] = 'unchecked';
    if (this.config.webhookSecret) {
      signature = verifyTermiiSignature(
        rawBody,
        getHeader(headers, TERMII_SIGNATURE_HEADER),
        this.config.webhookSecret,
      )
        ? 'valid'
        : 'invalid';
    }
    return { ...event, signature };
  }

  /**
   * "Connected" means: the API key authenticates against the configured base
   * URL AND the configured sender ID is registered and not blocked. Saving
   * settings never implies this; activation is a separate admin action (brief §16).
   */
  async testConnection(): Promise<SmsConnectionTestResult> {
    const started = Date.now();
    const balance = await this.getBalance();
    if (!balance.ok) {
      return {
        ok: false,
        message: `Authentication failed: ${balance.errorSanitized ?? 'no balance returned'}`,
        latencyMs: Date.now() - started,
        balance: balance.balance,
        currency: balance.currency,
        senderIdApproval: null,
      };
    }
    const senders = await this.listSenderIds();
    const wanted = this.config.senderId.toLowerCase();
    const match = senders.senderIds.find((s) => s.senderId.toLowerCase() === wanted);
    const latencyMs = Date.now() - started;
    const balanceText = `balance ${balance.balance}${balance.currency ? ` ${balance.currency}` : ''}`;
    if (!senders.ok) {
      return {
        ok: false,
        message: `Authenticated (${balanceText}) but the sender ID list could not be read: ${senders.errorSanitized ?? 'unknown error'}`,
        latencyMs,
        balance: balance.balance,
        currency: balance.currency,
        senderIdApproval: null,
      };
    }
    if (!match) {
      return {
        ok: false,
        message: `Authenticated (${balanceText}) but sender ID "${this.config.senderId}" is not registered on this account; request it and wait for Termii approval`,
        latencyMs,
        balance: balance.balance,
        currency: balance.currency,
        senderIdApproval: 'not_registered',
      };
    }
    const ok = match.approval === 'approved';
    return {
      ok,
      message: ok
        ? `Authenticated (${balanceText}); sender ID "${match.senderId}" is approved`
        : `Authenticated (${balanceText}); sender ID "${match.senderId}" status is "${match.status}" (${match.approval}); sends will fail until Termii approves it`,
      latencyMs,
      balance: balance.balance,
      currency: balance.currency,
      senderIdApproval: match.approval,
    };
  }

  /** Optional provider-managed OTP (Termii Token API). Not used for staff MFA. */
  async sendProviderOtp(input: ProviderOtpSendInput): Promise<ProviderOtpSendResult> {
    const phone = normalizeToE164(input.to);
    if (!phone.ok) {
      return { ok: false, pinId: null, providerStatus: null, errorSanitized: 'invalid recipient' };
    }
    const placeholder = input.placeholder ?? '< 1234 >';
    try {
      const res = await this.request('POST', '/api/sms/otp/send', {
        body: {
          message_type: 'NUMERIC',
          to: toTermiiFormat(phone.e164),
          from: input.from,
          channel: input.channel ?? 'dnd',
          pin_attempts: input.maxAttempts ?? 5,
          pin_time_to_live: input.ttlMinutes ?? 10,
          pin_length: input.pinLength ?? 6,
          pin_placeholder: placeholder,
          message_text: input.messageText ?? `Your SimplexD code is ${placeholder}. Never share it.`,
          pin_type: 'NUMERIC',
        },
      });
      const rec = asRecord(res.body);
      const pinId = str(rec?.pinId) ?? str(rec?.pin_id);
      if (!res.ok || !pinId) {
        return {
          ok: false,
          pinId: null,
          providerStatus: str(rec?.smsStatus),
          errorSanitized: this.failureMessage(res),
        };
      }
      return { ok: true, pinId, providerStatus: str(rec?.smsStatus) };
    } catch (err) {
      return { ok: false, pinId: null, providerStatus: null, errorSanitized: this.errorText(err) };
    }
  }

  async verifyProviderOtp(pinId: string, pin: string): Promise<ProviderOtpVerifyResult> {
    try {
      const res = await this.request('POST', '/api/sms/otp/verify', {
        body: { pin_id: pinId, pin },
      });
      const rec = asRecord(res.body);
      const verified = rec?.verified;
      if (verified === true || (typeof verified === 'string' && verified.toLowerCase() === 'true')) {
        return { ok: true, status: 'verified' };
      }
      if (typeof verified === 'string' && verified.toLowerCase() === 'expired') {
        return { ok: false, status: 'expired' };
      }
      if (!res.ok) return { ok: false, status: 'error', errorSanitized: this.failureMessage(res) };
      return { ok: false, status: 'invalid' };
    } catch (err) {
      return { ok: false, status: 'error', errorSanitized: this.errorText(err) };
    }
  }
}

export function createTermiiSmsProvider(
  config: TermiiConfigInput,
  deps: TermiiDeps = {},
): TermiiSmsProvider {
  return new TermiiSmsProvider(config, deps);
}

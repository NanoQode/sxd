import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createTransport } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';
import { checkDestination, type DestinationCheck, type DestinationPolicy } from '../net/ssrf';
import { checkApprovedSender, emailDomain } from './sender-policy';
import type {
  MailErrorCode,
  MailMessage,
  MailProvider,
  MailProviderDescription,
  MailSecurity,
  MailSendResult,
  MailTlsMode,
  MailVerifyResult,
} from './types';

/**
 * SMTP adapter on nodemailer (brief §14).
 *
 * Guarantees:
 * - the destination host is validated with the SSRF policy (allow-list,
 *   loopback/private/metadata ranges, DNS resolution) before any socket opens,
 *   and the connection is made to the address that passed the check;
 * - plaintext SMTP (`security: 'none'`) is only accepted with `allowPrivate`,
 *   i.e. development against Mailpit;
 * - certificate verification is never disabled: `tls.rejectUnauthorized`
 *   stays at its secure default and `assertSecureTransportOptions` refuses
 *   any option set that turns it off;
 * - STARTTLS uses `requireTLS` (the session fails rather than falling back
 *   to plaintext), implicit TLS uses `secure: true`;
 * - errors are sanitised: passwords, usernames and AUTH exchanges are redacted.
 */

const HOSTNAME =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$|^\[[0-9a-fA-F:.]+\]$/;

/**
 * Address syntax accepted for recipients and senders. Deliberately permits a
 * single-label host (`no-reply@localhost`) so Mailpit works in development;
 * production quality is enforced by the approved-sender-domain list.
 */
export const EMAIL_ADDRESS = /^[A-Za-z0-9._%+'-]+@(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/;
const EMAIL = EMAIL_ADDRESS;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

const emailSchema = z.string().trim().max(254).regex(EMAIL_ADDRESS, 'invalid email address');

const mailAddressSchema = z.object({
  email: emailSchema,
  name: z.string().max(120).optional(),
});

export const smtpConfigSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(HOSTNAME, 'host must be a hostname or IP literal'),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['implicit-tls', 'starttls', 'none']),
    username: z.string().max(256).nullish(),
    /** Plaintext only in memory; stored through the secrets envelope. */
    password: z.string().max(1024).nullish(),
    from: z.object({ email: emailSchema, name: z.string().min(1).max(120) }),
    replyTo: mailAddressSchema.nullish(),
    /** SSRF allow-list (exact host or `.suffix`); empty = any public host. Operator-controlled. */
    allowedHosts: z.array(z.string()).default([]),
    /** Development only: permits localhost/private hosts (Mailpit) and plaintext SMTP. */
    allowPrivate: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(120000).default(15000),
    /** Approved sender domains (exact or `.suffix`); empty = unrestricted (development only). */
    approvedSenderDomains: z.array(z.string()).default([]),
    /** EHLO/HELO name; defaults to the machine hostname. */
    localName: z.string().max(253).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.security === 'none' && !config.allowPrivate) {
      ctx.addIssue({
        code: 'custom',
        path: ['security'],
        message:
          "security 'none' (plaintext SMTP) is only permitted in development with allowPrivate; use implicit-tls or starttls",
      });
    }
    if ((config.username && !config.password) || (!config.username && config.password)) {
      ctx.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'username and password must be provided together',
      });
    }
  });

export type SmtpConfigInput = z.input<typeof smtpConfigSchema>;
export type SmtpConfig = z.output<typeof smtpConfigSchema>;

export interface SmtpTransportLike {
  sendMail(mail: Mail.Options): Promise<SMTPTransport.SentMessageInfo>;
  verify(): Promise<true>;
  close(): void;
}

export interface SmtpDeps {
  createTransport?: (options: SMTPTransport.Options) => SmtpTransportLike;
  checkDestination?: (
    host: string,
    port: number,
    policy: DestinationPolicy,
  ) => Promise<DestinationCheck>;
}

export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export function tlsModeFor(security: MailSecurity): MailTlsMode {
  if (security === 'implicit-tls') return 'implicit';
  if (security === 'starttls') return 'starttls';
  return 'none';
}

/**
 * Pure mapping from validated config to nodemailer options. `connectHost` is
 * the address that passed the destination check; the configured hostname is
 * kept as the TLS server name so certificate validation is unaffected.
 */
export function buildTransportOptions(
  config: SmtpConfig,
  connectHost: string = config.host,
): SMTPTransport.Options {
  const tls: NonNullable<SMTPTransport.Options['tls']> = { minVersion: 'TLSv1.2' };
  const bareHost = config.host.replace(/^\[|\]$/g, '');
  if (!isIP(bareHost)) tls.servername = bareHost;
  const options: SMTPTransport.Options = {
    host: connectHost,
    port: config.port,
    secure: config.security === 'implicit-tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
    dnsTimeout: config.timeoutMs,
    tls,
  };
  if (config.username) {
    options.auth = { user: config.username, pass: config.password ?? '' };
  }
  if (config.localName) options.name = config.localName;
  return options;
}

/** Last line of defence: refuses any option set that disables certificate checks. */
export function assertSecureTransportOptions(options: SMTPTransport.Options): void {
  if (options.tls && options.tls.rejectUnauthorized === false) {
    throw new MailError(
      'tls',
      'refusing SMTP transport with certificate verification disabled (tls.rejectUnauthorized=false)',
    );
  }
  if (options.ignoreTLS && (options.requireTLS || options.secure)) {
    throw new MailError('tls', 'contradictory TLS options');
  }
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Secrets to redact from any text derived from an SMTP session. */
export function smtpSecretVariants(username?: string | null, password?: string | null): string[] {
  const out: string[] = [];
  if (password) {
    out.push(password, base64(password));
    if (username)
      out.push(
        base64(`\0${username}\0${password}`),
        base64(`${username}\0${username}\0${password}`),
      );
  }
  if (username && username.length >= 3) out.push(username, base64(username));
  return out;
}

function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/(AUTH\s+(?:PLAIN|LOGIN|CRAM-MD5|XOAUTH2)\s+)\S+/gi, '$1[redacted]');
  out = out.replace(/(user|pass|password)(=|:\s*)[^\s,;]+/gi, '$1$2[redacted]');
  out = printable(out);
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
  'ETLS',
]);

export interface SanitizedMailError {
  code: MailErrorCode;
  message: string;
  retryable: boolean;
}

/** Maps nodemailer/socket errors to stable codes and strips credentials. */
export function sanitizeMailError(err: unknown, secrets: string[] = []): SanitizedMailError {
  if (err instanceof MailError) {
    return {
      code: err.code,
      message: redactSecrets(err.message, secrets),
      retryable: err.retryable,
    };
  }
  const e = (err ?? {}) as {
    code?: string;
    command?: string;
    response?: string;
    responseCode?: number;
    message?: string;
  };
  const raw = [e.message, e.response].filter((v): v is string => Boolean(v)).join(' | ');
  const text = redactSecrets(raw || 'unknown error', secrets);
  const code = e.code ?? '';
  if (code === 'EAUTH') {
    return {
      code: 'auth',
      message: `SMTP authentication failed; check the username and password: ${text}`,
      retryable: false,
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT' || /timed? ?out/i.test(text)) {
    return { code: 'timeout', message: `SMTP connection timed out: ${text}`, retryable: true };
  }
  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'dns', message: `SMTP host could not be resolved: ${text}`, retryable: true };
  }
  if (TLS_ERROR_CODES.has(code) || /certificate|self.signed|handshake|ssl|tls/i.test(text)) {
    return {
      code: 'tls',
      message: `TLS handshake failed; fix the server certificate or hostname (certificate checks cannot be disabled): ${text}`,
      retryable: false,
    };
  }
  if (
    code === 'ECONNECTION' ||
    code === 'ESOCKET' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET'
  ) {
    return {
      code: 'connection',
      message: `could not connect to the SMTP server: ${text}`,
      retryable: true,
    };
  }
  if (code === 'EENVELOPE' || code === 'EENVELOPEFORMAT') {
    const transient =
      typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500;
    return {
      code: 'envelope',
      message: `the server rejected the sender or a recipient: ${text}`,
      retryable: transient,
    };
  }
  if (code === 'EMESSAGE' || code === 'ESTREAM') {
    return {
      code: 'message',
      message: `the server rejected the message content: ${text}`,
      retryable: false,
    };
  }
  return { code: 'unknown', message: text, retryable: false };
}

export function maskUsername(username: string | null | undefined): string {
  if (!username) return 'not set';
  const at = username.indexOf('@');
  if (at > 0) return `${username.slice(0, Math.min(2, at))}•••${username.slice(at)}`;
  return `${username.slice(0, Math.min(2, username.length))}•••`;
}

export function formatMailAddress(address: { email: string; name?: string | null }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MailError('timeout', `${label} timed out after ${ms}ms`, true)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function deterministicMessageId(idempotencyKey: string, fromEmail: string): string {
  const domain = emailDomain(fromEmail) ?? 'simplexd.local';
  return `<${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}@${domain}>`;
}

export function validateMailMessage(message: MailMessage): MailError | null {
  if (!Array.isArray(message.to) || message.to.length === 0) {
    return new MailError('invalid_recipient', 'at least one recipient is required');
  }
  for (const recipient of message.to) {
    if (!recipient || !EMAIL.test(recipient.email)) {
      return new MailError('invalid_recipient', 'a recipient address is not a valid email');
    }
  }
  if (!EMAIL.test(message.from.email)) {
    return new MailError('sender_not_approved', 'the sender address is not a valid email');
  }
  if (!message.subject.trim()) return new MailError('message', 'subject is required');
  if (!message.text.trim()) return new MailError('message', 'a plain-text body is required');
  if (!message.idempotencyKey.trim()) return new MailError('message', 'idempotencyKey is required');
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) {
      return new MailError('message', `invalid header ${name}`);
    }
  }
  return null;
}

export class SmtpMailProvider implements MailProvider {
  readonly id = 'smtp' as const;
  private readonly config: SmtpConfig;
  private readonly createTransportImpl: NonNullable<SmtpDeps['createTransport']>;
  private readonly checkDestinationImpl: NonNullable<SmtpDeps['checkDestination']>;
  private readonly secrets: string[];

  constructor(input: SmtpConfigInput, deps: SmtpDeps = {}) {
    const parsed = smtpConfigSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new MailError('unknown', `invalid SMTP configuration: ${issues}`);
    }
    this.config = parsed.data;
    this.createTransportImpl =
      deps.createTransport ??
      ((options) => createTransport(options) as unknown as SmtpTransportLike);
    this.checkDestinationImpl = deps.checkDestination ?? checkDestination;
    this.secrets = smtpSecretVariants(this.config.username, this.config.password);
  }

  describe(): MailProviderDescription {
    return {
      adapter: 'smtp',
      host: this.config.host,
      port: this.config.port,
      security: this.config.security,
      username: maskUsername(this.config.username),
      from: formatMailAddress(this.config.from),
      replyTo: this.config.replyTo ? formatMailAddress(this.config.replyTo) : null,
    };
  }

  get tlsMode(): MailTlsMode {
    return tlsModeFor(this.config.security);
  }

  /** Runs the SSRF policy and returns the address to connect to. */
  private async resolveConnectHost(): Promise<string> {
    const bareHost = this.config.host.replace(/^\[|\]$/g, '');
    const check = await this.checkDestinationImpl(bareHost, this.config.port, {
      allowedHosts: this.config.allowedHosts,
      allowPrivate: this.config.allowPrivate,
    });
    if (!check.ok) {
      throw new MailError(
        'destination',
        `SMTP host rejected by the destination policy: ${check.reason ?? 'blocked'}`,
      );
    }
    const resolved = check.resolved ?? [];
    // Prefer IPv4 so hosts with unreachable AAAA records still connect; fall back to the hostname.
    return resolved.find((a) => isIP(a) === 4) ?? resolved[0] ?? bareHost;
  }

  private async withTransport<T>(fn: (transport: SmtpTransportLike) => Promise<T>): Promise<T> {
    const connectHost = await this.resolveConnectHost();
    const options = buildTransportOptions(this.config, connectHost);
    assertSecureTransportOptions(options);
    const transport = this.createTransportImpl(options);
    try {
      return await fn(transport);
    } finally {
      try {
        transport.close();
      } catch {
        // closing is best effort
      }
    }
  }

  async verifyConnection(): Promise<MailVerifyResult> {
    const started = Date.now();
    const tls = this.tlsMode;
    try {
      await this.withTransport((transport) =>
        withTimeout(transport.verify(), this.config.timeoutMs + 1000, 'SMTP verification'),
      );
      const auth = this.config.username
        ? ` and authenticated as ${maskUsername(this.config.username)}`
        : ' without authentication';
      return {
        ok: true,
        message: `Connected to ${this.config.host}:${this.config.port} (${tls})${auth}`,
        tls,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const sanitized = sanitizeMailError(err, this.secrets);
      return {
        ok: false,
        message: sanitized.message,
        tls,
        latencyMs: Date.now() - started,
        errorCode: sanitized.code,
      };
    }
  }

  async send(message: MailMessage): Promise<MailSendResult> {
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
    const sender = checkApprovedSender(message.from.email, this.config.approvedSenderDomains);
    if (!sender.ok) {
      return {
        accepted: false,
        providerMessageId: null,
        response: null,
        errorSanitized: sender.reason ?? 'sender not approved',
        errorCode: 'sender_not_approved',
        retryable: false,
      };
    }
    const messageId = deterministicMessageId(message.idempotencyKey, message.from.email);
    const headers: Record<string, string> = { ...(message.headers ?? {}) };
    if (message.tags && message.tags.length > 0) {
      headers['X-SimplexD-Tags'] = message.tags.map((t) => t.replace(/[^\w.-]/g, '')).join(',');
    }
    const mail: Mail.Options = {
      from: { name: message.from.name, address: message.from.email },
      to: message.to.map((a) => ({ name: a.name ?? '', address: a.email })),
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId,
      headers,
    };
    const replyTo = message.replyTo ?? this.config.replyTo ?? null;
    if (replyTo) mail.replyTo = { name: replyTo.name ?? '', address: replyTo.email };

    try {
      const info = await this.withTransport((transport) =>
        withTimeout(transport.sendMail(mail), this.config.timeoutMs * 2, 'SMTP send'),
      );
      const acceptedCount = info.accepted?.length ?? 0;
      const rejectedCount = info.rejected?.length ?? 0;
      const response = info.response ? redactSecrets(info.response, this.secrets) : null;
      if (acceptedCount === 0) {
        return {
          accepted: false,
          providerMessageId: info.messageId ?? messageId,
          response,
          errorSanitized: `the server rejected all ${rejectedCount} recipient(s)`,
          errorCode: 'envelope',
          retryable: false,
        };
      }
      return {
        accepted: true,
        providerMessageId: info.messageId ?? messageId,
        response,
        ...(rejectedCount > 0
          ? {
              errorSanitized: `${rejectedCount} recipient(s) rejected by the server`,
              errorCode: 'envelope' as const,
            }
          : {}),
        retryable: false,
      };
    } catch (err) {
      const sanitized = sanitizeMailError(err, this.secrets);
      return {
        accepted: false,
        providerMessageId: null,
        response: null,
        errorSanitized: sanitized.message,
        errorCode: sanitized.code,
        retryable: sanitized.retryable,
      };
    }
  }
}

export function createSmtpMailProvider(
  config: SmtpConfigInput,
  deps: SmtpDeps = {},
): SmtpMailProvider {
  return new SmtpMailProvider(config, deps);
}

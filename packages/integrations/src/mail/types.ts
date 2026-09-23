/**
 * Mail provider contract (brief §14).
 *
 * "accepted" means the SMTP server accepted the message for at least one
 * recipient (a 250 after DATA). It is NOT delivery: delivery is only shown
 * when provider feedback (bounce/complaint webhooks, none for plain SMTP)
 * proves it. Every error string is sanitised: it never contains the SMTP
 * password, the username or an AUTH exchange.
 */

export type MailAdapterId = 'smtp' | 'dev';
export type MailSecurity = 'implicit-tls' | 'starttls' | 'none';
export type MailTlsMode = 'implicit' | 'starttls' | 'none' | 'unknown';

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  to: MailAddress[];
  from: { email: string; name: string };
  replyTo?: MailAddress;
  subject: string;
  /** Plain-text part; always required so every message has an accessible fallback. */
  text: string;
  /** HTML part (branded layout from `templates/wrapHtmlLayout`). */
  html: string;
  /** Extra headers; names must be token characters and values single-line. */
  headers?: Record<string, string>;
  /** Categorisation for the send log (e.g. template key); exposed as X-SimplexD-Tags. */
  tags?: string[];
  /** Stable key for the business event; also seeds the Message-ID so retries dedupe at the receiver. */
  idempotencyKey: string;
}

export type MailErrorCode =
  | 'auth'
  | 'connection'
  | 'timeout'
  | 'envelope'
  | 'tls'
  | 'dns'
  | 'message'
  | 'destination'
  | 'sender_not_approved'
  | 'invalid_recipient'
  | 'unknown';

export interface MailSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  /** Sanitised SMTP response line, e.g. `250 2.0.0 OK queued as ABC123`. */
  response: string | null;
  errorSanitized?: string | null;
  errorCode?: MailErrorCode;
  /** Hint for the retry queue. */
  retryable?: boolean;
}

export interface MailVerifyResult {
  ok: boolean;
  message: string;
  tls: MailTlsMode;
  latencyMs: number;
  errorCode?: MailErrorCode;
}

export interface MailProviderDescription {
  adapter: MailAdapterId;
  host: string;
  port: number;
  security: MailSecurity;
  /** Masked, e.g. `ap•••@example.com` or `not set`. */
  username: string;
  from: string;
  replyTo: string | null;
}

export interface MailProvider {
  readonly id: MailAdapterId;
  send(message: MailMessage): Promise<MailSendResult>;
  verifyConnection(): Promise<MailVerifyResult>;
  /** Safe for admin screens and diagnostics: never includes the password. */
  describe(): MailProviderDescription;
}

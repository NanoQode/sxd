/**
 * Calendar provider errors. Messages are sanitised before they are stored so
 * that sanitized integration logs and `last_error_sanitized` columns never
 * carry access tokens, refresh tokens, authorisation codes or client secrets.
 */

export type CalendarErrorCode =
  | 'auth'
  | 'conflict'
  | 'not_configured'
  | 'not_found'
  | 'already_exists'
  | 'rate_limited'
  | 'invalid_request'
  | 'network'
  | 'provider';

const REDACTIONS: Array<[RegExp, string]> = [
  [/ya29\.[A-Za-z0-9\-_.]+/g, '[redacted-access-token]'],
  [/\b1\/\/[A-Za-z0-9\-_]+/g, '[redacted-refresh-token]'],
  [/GOCSPX-[A-Za-z0-9_-]+/g, '[redacted-client-secret]'],
  [/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer [redacted]'],
  [
    /(access_token|refresh_token|client_secret|id_token|code|token|key)=([^&\s"']+)/gi,
    '$1=[redacted]',
  ],
  [/"(access_token|refresh_token|client_secret|id_token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"'],
];

const MAX_MESSAGE_LENGTH = 500;

/** Removes anything that looks like a credential and truncates long provider text. */
export function sanitizeErrorMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : out;
}

export interface CalendarErrorOptions {
  code?: CalendarErrorCode;
  httpStatus?: number | null;
  retryable?: boolean;
  /** Provider-side reason (for example `insufficientPermissions`), already safe to log. */
  providerReason?: string | null;
}

export class CalendarProviderError extends Error {
  readonly code: CalendarErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly providerReason: string | null;

  constructor(message: string, options: CalendarErrorOptions = {}) {
    super(sanitizeErrorMessage(message));
    this.name = 'CalendarProviderError';
    this.code = options.code ?? 'provider';
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = options.retryable ?? false;
    this.providerReason = options.providerReason
      ? sanitizeErrorMessage(options.providerReason)
      : null;
  }
}

export const RECONNECT_INSTRUCTIONS =
  'Google no longer accepts the stored authorisation. Ask the organiser to reconnect Google Workspace from Admin → Integrations → Google Workspace (Connect organiser). Typical causes: the grant was revoked in the Google account, the refresh token was unused for six months, the OAuth app is still in "Testing" status (grants expire after 7 days), or the token was superseded by a newer grant for the same client.';

/**
 * Raised when Google rejects the credentials: `invalid_grant` on refresh or
 * exchange, HTTP 401, or a 403 caused by missing scopes. The connection must
 * be shown as `expired` and the organiser must reconnect.
 */
export class CalendarAuthError extends CalendarProviderError {
  readonly reconnectRequired: boolean;
  readonly instructions: string;

  constructor(
    message: string,
    options: CalendarErrorOptions & { reconnectRequired?: boolean; instructions?: string } = {},
  ) {
    super(message, { ...options, code: 'auth', retryable: false });
    this.name = 'CalendarAuthError';
    this.reconnectRequired = options.reconnectRequired ?? true;
    this.instructions = options.instructions ?? RECONNECT_INSTRUCTIONS;
  }
}

/**
 * Raised on HTTP 412 (If-Match etag mismatch): the event changed on Google's
 * side since we last read it. Reload the event, reconcile and retry with the
 * fresh etag; never overwrite blindly.
 */
export class CalendarConflictError extends CalendarProviderError {
  constructor(message = 'The calendar event changed since it was last read (etag mismatch)') {
    super(message, { code: 'conflict', httpStatus: 412, retryable: false });
    this.name = 'CalendarConflictError';
  }
}

export class CalendarNotConfiguredError extends CalendarProviderError {
  constructor(message: string) {
    super(message, { code: 'not_configured', retryable: false });
    this.name = 'CalendarNotConfiguredError';
  }
}

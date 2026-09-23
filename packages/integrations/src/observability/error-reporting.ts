/**
 * Distributed error tracking without an SDK (brief §17). When SENTRY_DSN is
 * set, sanitized error events are POSTed to Sentry's envelope endpoint:
 *
 *   DSN  https://<publicKey>@<host>[/<path>]/<projectId>
 *   URL  https://<host>[/<path>]/api/<projectId>/envelope/
 *   Auth X-Sentry-Auth: Sentry sentry_version=7, sentry_client=..., sentry_key=<publicKey>
 *
 * What an event contains: error type and scrubbed message, a scrubbed stack
 * (file, function, line, column; no source or local variables), release
 * (APP_VERSION), environment (APP_ENV), the source process (web/worker), the
 * correlation id, the route pattern with identifiers replaced, the HTTP
 * method or job type, and small operational tags. Never: request bodies,
 * headers, cookies, tokens, user identifiers, e-mail addresses or phone
 * numbers. Sending is rate limited per process and every failure is
 * swallowed (one warning per outage). Works in Node and edge runtimes
 * (global fetch and crypto only).
 */

export interface ParsedDsn {
  protocol: 'http' | 'https';
  publicKey: string;
  host: string;
  projectId: string;
  envelopeUrl: string;
}

export function parseSentryDsn(dsn: string | null | undefined): ParsedDsn | null {
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const publicKey = url.username;
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    protocol,
    publicKey,
    host: url.host,
    projectId,
    envelopeUrl: `${protocol}://${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

const MAX_TEXT = 1000;
const MAX_FRAMES = 50;
const MAX_CAUSES = 3;

/** Removes credentials, contact details and opaque identifiers from free text. */
export function scrubText(text: string): string {
  return text
    .replace(/(sk|pk)_(test|live)_[A-Za-z0-9]+/g, '$1_$2_[redacted]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]+)?/g, '[jwt]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|apikey|otp|signature|session)(\s*[=:]\s*)[^\s&,;'"]+/gi,
      '$1$2[redacted]',
    )
    .replace(/\?[^\s'"]*/g, '?[query]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hex]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, '[opaque]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
    .slice(0, MAX_TEXT);
}

const ID_SEGMENT =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{16,})$/i;

/** Path only, with identifiers, tokens and numbers replaced by `:id`. */
export function scrubRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const path = route.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return scrubText(path).slice(0, 200);
  return path
    .split('/')
    .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/')
    .slice(0, 200);
}

export interface StackFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|(.+?))\)?\s*$/;

function normaliseFilename(file: string): string {
  let out = file.replace(/^file:\/\//, '');
  const nm = out.indexOf('/node_modules/');
  if (nm >= 0) return out.slice(nm + 1);
  const cwd =
    typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '';
  if (cwd && out.startsWith(cwd)) out = `.${out.slice(cwd.length)}`;
  // Strip user home directories that can name people (e.g. /home/<user>/...).
  return out.replace(/^\/(?:home|Users)\/[^/]+/, '~');
}

/** Frames oldest-first (Sentry order) with paths and symbols only. */
export function scrubStack(stack: string | null | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const [, fn, file, lineno, colno, bare] = m;
    const filename = normaliseFilename(file ?? bare ?? '<anonymous>');
    frames.push({
      filename,
      function: fn?.trim() || '<anonymous>',
      ...(lineno ? { lineno: Number(lineno) } : {}),
      ...(colno ? { colno: Number(colno) } : {}),
      in_app: !filename.startsWith('node_modules/') && !filename.startsWith('node:'),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

export interface ErrorContext {
  correlationId?: string | null;
  /** Route pattern (preferred) or request path; identifiers are scrubbed. */
  route?: string | null;
  /** HTTP method or job type. */
  method?: string | null;
  level?: 'fatal' | 'error' | 'warning';
  /** React/Next error digest, when present. */
  digest?: string | null;
  tags?: Record<string, string | number | boolean | null | undefined>;
}

export interface SentryException {
  type: string;
  value: string;
  stacktrace?: { frames: StackFrame[] };
  mechanism?: { type: string; handled: boolean };
}

export interface SentryEvent {
  event_id: string;
  timestamp: string;
  platform: 'node';
  level: 'fatal' | 'error' | 'warning';
  logger: string;
  release?: string;
  environment?: string;
  transaction?: string;
  tags: Record<string, string>;
  exception: { values: SentryException[] };
  sdk: { name: string; version: string };
}

export const REPORTER_CLIENT = 'simplexd-error-reporter';
export const REPORTER_VERSION = '1.0';

function eventId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function exceptionOf(error: unknown, handled: boolean): SentryException {
  if (error instanceof Error) {
    const frames = scrubStack(error.stack);
    return {
      type: error.name || 'Error',
      value: scrubText(error.message || '(no message)'),
      ...(frames.length ? { stacktrace: { frames } } : {}),
      mechanism: { type: 'generic', handled },
    };
  }
  const value =
    typeof error === 'string'
      ? scrubText(error)
      : error === null || error === undefined
        ? String(error)
        : `non-error thrown (${typeof error})`;
  return { type: 'Error', value, mechanism: { type: 'generic', handled } };
}

/** Pure event construction; exported for tests. */
export function buildSentryEvent(
  error: unknown,
  context: ErrorContext,
  meta: { source: string; release?: string | null; environment?: string | null; now?: Date },
): SentryEvent {
  // Chained causes, oldest first, as Sentry expects.
  const values: SentryException[] = [];
  let current: unknown = error;
  for (let i = 0; i <= MAX_CAUSES && current !== undefined; i += 1) {
    values.unshift(exceptionOf(current, true));
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined || current === null) break;
  }
  const route = scrubRoute(context.route);
  const tags: Record<string, string> = { source: meta.source };
  if (context.correlationId) tags.correlation_id = String(context.correlationId).slice(0, 128);
  if (route) tags.route = route;
  if (context.method) tags.method = String(context.method).slice(0, 64);
  if (context.digest) tags.digest = String(context.digest).slice(0, 64);
  for (const [key, value] of Object.entries(context.tags ?? {})) {
    if (value === undefined || value === null) continue;
    tags[key.slice(0, 32)] = scrubText(String(value)).slice(0, 200);
  }
  return {
    event_id: eventId(),
    timestamp: (meta.now ?? new Date()).toISOString(),
    platform: 'node',
    level: context.level ?? 'error',
    logger: meta.source,
    ...(meta.release ? { release: meta.release } : {}),
    ...(meta.environment ? { environment: meta.environment } : {}),
    ...(route ? { transaction: route } : {}),
    tags,
    exception: { values },
    sdk: { name: REPORTER_CLIENT, version: REPORTER_VERSION },
  };
}

export function buildEnvelope(event: SentryEvent, sentAt: Date): string {
  const body = JSON.stringify(event);
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString() });
  const item = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: new TextEncoder().encode(body).length,
  });
  return `${header}\n${item}\n${body}`;
}

export type CaptureOutcome = 'sent' | 'dropped' | 'disabled' | 'failed';

export interface ErrorReporterOptions {
  dsn?: string | null;
  release?: string | null;
  environment?: string | null;
  /** Process name recorded as `logger`/`source`: web or worker. */
  source: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Events accepted per rolling minute; the rest are dropped (default 30). */
  maxEventsPerMinute?: number;
  timeoutMs?: number;
  /** Receives the single warning per outage. */
  onWarning?: (message: string, detail: Record<string, unknown>) => void;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  capture(error: unknown, context?: ErrorContext): Promise<CaptureOutcome>;
  stats(): { sent: number; dropped: number; failed: number };
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const dsn = parseSentryDsn(options.dsn);
  const now = options.now ?? (() => new Date());
  const limit = options.maxEventsPerMinute ?? 30;
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch = options.fetch ?? globalThis.fetch;
  const stats = { sent: 0, dropped: 0, failed: 0 };
  const recent: number[] = [];
  let pausedUntil = 0;
  let warned = false;

  const warn = (message: string, detail: Record<string, unknown>) => {
    if (warned) return;
    warned = true;
    options.onWarning?.(message, detail);
  };

  if (!dsn || typeof doFetch !== 'function') {
    if (options.dsn && !dsn) options.onWarning?.('SENTRY_DSN is not a valid DSN; ignored', {});
    return {
      enabled: false,
      capture: async () => 'disabled',
      stats: () => ({ ...stats }),
    };
  }

  return {
    enabled: true,
    stats: () => ({ ...stats }),
    async capture(error, context = {}) {
      const t = now().getTime();
      while (recent.length > 0 && recent[0]! <= t - 60_000) recent.shift();
      if (t < pausedUntil || recent.length >= limit) {
        stats.dropped += 1;
        return 'dropped';
      }
      recent.push(t);
      try {
        const event = buildSentryEvent(error, context, {
          source: options.source,
          release: options.release,
          environment: options.environment,
          now: now(),
        });
        const res = await doFetch(dsn.envelopeUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_client=${REPORTER_CLIENT}/${REPORTER_VERSION}, sentry_key=${dsn.publicKey}`,
          },
          body: buildEnvelope(event, now()),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 60);
          pausedUntil = t + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000;
          stats.dropped += 1;
          return 'dropped';
        }
        if (!res.ok) {
          stats.failed += 1;
          warn('error reporting failed; further failures are not logged', { status: res.status });
          return 'failed';
        }
        stats.sent += 1;
        warned = false;
        return 'sent';
      } catch (err) {
        stats.failed += 1;
        warn('error reporting failed; further failures are not logged', {
          reason: err instanceof Error ? scrubText(err.message) : 'unknown',
        });
        return 'failed';
      }
    },
  };
}

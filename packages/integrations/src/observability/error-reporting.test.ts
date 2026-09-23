import { describe, expect, it, vi } from 'vitest';
import {
  buildEnvelope,
  buildSentryEvent,
  createErrorReporter,
  parseSentryDsn,
  scrubRoute,
  scrubStack,
  scrubText,
  type SentryEvent,
} from './error-reporting';
import { LOG_REDACT_PATHS, SENSITIVE_LOG_KEYS } from './redaction';

const DSN = 'https://abc123publickey@o123.ingest.sentry.io/456';

function fakeFetch(status = 200, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 204 ? null : '{}', { status, headers });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function envelopeOf(init: RequestInit): { header: unknown; item: unknown; event: SentryEvent } {
  const [header, item, body] = String(init.body).split('\n');
  return { header: JSON.parse(header!), item: JSON.parse(item!), event: JSON.parse(body!) };
}

describe('parseSentryDsn', () => {
  it('derives the envelope endpoint and public key from a DSN', () => {
    expect(parseSentryDsn(DSN)).toEqual({
      protocol: 'https',
      publicKey: 'abc123publickey',
      host: 'o123.ingest.sentry.io',
      projectId: '456',
      envelopeUrl: 'https://o123.ingest.sentry.io/api/456/envelope/',
    });
    expect(parseSentryDsn('http://key@sentry.internal:9000/prefix/path/12')).toMatchObject({
      protocol: 'http',
      host: 'sentry.internal:9000',
      projectId: '12',
      envelopeUrl: 'http://sentry.internal:9000/prefix/path/api/12/envelope/',
    });
  });

  it('rejects malformed DSNs', () => {
    for (const bad of [
      '',
      'not a url',
      'https://sentry.io/456',
      'https://key@sentry.io/',
      'ftp://k@h/1',
      'https://key@host/abc',
    ])
      expect(parseSentryDsn(bad), bad).toBeNull();
    expect(parseSentryDsn(undefined)).toBeNull();
  });
});

describe('scrubbing', () => {
  it('removes credentials, contact details, query strings and opaque identifiers from text', () => {
    const text =
      'Paystack sk_live_ABC123 rejected: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig for ada@example.com (+234 801 234 5678) at /api/x?token=t1&password=p2; api_key=k3 hash 0123456789abcdef0123456789abcdef0123456789abcdef';
    const out = scrubText(text);
    expect(out).not.toMatch(/ABC123|eyJ|example\.com|801|t1|p2|k3|0123456789abcdef/);
    expect(out).toContain('sk_live_[redacted]');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    expect(out).toContain('?[query]');
    expect(out).toContain('api_key=[redacted]');
    expect(out).toContain('[hex]');
    expect(scrubText('word '.repeat(1000))).toHaveLength(1000);
    // Error codes are kept: they are diagnostics, not secrets.
    expect(scrubText('database error code: 42883')).toBe('database error code: 42883');
  });

  it('keeps the route shape but not identifiers, tokens or query strings', () => {
    expect(scrubRoute('/api/v1/invoices/5f1e3c8a-1b2c-4d3e-9f00-abcdef123456/lines?expand=1')).toBe(
      '/api/v1/invoices/:id/lines',
    );
    expect(scrubRoute('https://app.example/invitations/AbCdEfGhIjKlMnOpQrStUv#x')).toBe(
      '/invitations/:id',
    );
    expect(scrubRoute('/admin/jobs/[jobId]/retry')).toBe('/admin/jobs/[jobId]/retry');
    expect(scrubRoute('/portal/requests/42')).toBe('/portal/requests/:id');
    expect(scrubRoute(null)).toBeNull();
  });

  it('turns a V8 stack into frames with paths and symbols only, oldest first', () => {
    const stack = [
      'Error: boom',
      `    at handler (${process.cwd()}/apps/web/src/app/api/route.ts:10:5)`,
      '    at /home/someone/project/node_modules/next/dist/server.js:1:2',
      '    at node:internal/process/task_queues:95:5',
      '    at file:///home/someone/project/apps/worker/src/runner.ts:42:9',
    ].join('\n');
    const frames = scrubStack(stack);
    expect(frames.map((f) => f.filename)).toEqual([
      '~/project/apps/worker/src/runner.ts',
      'node:internal/process/task_queues',
      'node_modules/next/dist/server.js',
      './apps/web/src/app/api/route.ts',
    ]);
    expect(frames[3]).toEqual({
      filename: './apps/web/src/app/api/route.ts',
      function: 'handler',
      lineno: 10,
      colno: 5,
      in_app: true,
    });
    expect(frames.filter((f) => f.in_app).map((f) => f.filename)).toEqual([
      '~/project/apps/worker/src/runner.ts',
      './apps/web/src/app/api/route.ts',
    ]);
    expect(JSON.stringify(frames)).not.toContain('someone');
    expect(scrubStack(undefined)).toEqual([]);
  });
});

describe('buildSentryEvent', () => {
  it('carries release, environment, correlation id, route and tags, and chains causes oldest first', () => {
    const inner = new TypeError('connect ECONNREFUSED 10.0.0.1:5432 user=admin password=hunter2');
    const outer = new Error('query failed for ada@example.com', { cause: inner });
    const event = buildSentryEvent(
      outer,
      {
        correlationId: 'corr-1',
        route: '/api/v1/invoices/123',
        method: 'POST',
        digest: 'd-1',
        tags: { job_type: 'x', attempt: 2, skip: null },
      },
      {
        source: 'web',
        release: '1.2.3',
        environment: 'staging',
        now: new Date('2026-09-23T10:00:00Z'),
      },
    );
    expect(event).toMatchObject({
      platform: 'node',
      level: 'error',
      logger: 'web',
      release: '1.2.3',
      environment: 'staging',
      transaction: '/api/v1/invoices/:id',
      timestamp: '2026-09-23T10:00:00.000Z',
      tags: {
        source: 'web',
        correlation_id: 'corr-1',
        route: '/api/v1/invoices/:id',
        method: 'POST',
        digest: 'd-1',
        job_type: 'x',
        attempt: '2',
      },
      sdk: { name: 'simplexd-error-reporter', version: '1.0' },
    });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.exception.values.map((v) => v.type)).toEqual(['TypeError', 'Error']);
    expect(event.exception.values[0]!.value).toBe(
      'connect ECONNREFUSED 10.0.0.1:5432 user=admin password=[redacted]',
    );
    expect(event.exception.values[1]!.value).toBe('query failed for [email]');
    expect(JSON.stringify(event)).not.toMatch(/hunter2|example\.com/);
  });

  it('describes non-error throwables without serialising them', () => {
    const event = buildSentryEvent({ password: 'p', body: 'x' }, {}, { source: 'worker' });
    expect(event.exception.values).toEqual([
      {
        type: 'Error',
        value: 'non-error thrown (object)',
        mechanism: { type: 'generic', handled: true },
      },
    ]);
    expect(buildSentryEvent('token=abc', {}, { source: 'worker' }).exception.values[0]!.value).toBe(
      'token=[redacted]',
    );
  });

  it('serialises an envelope with header, item header and event', () => {
    const event = buildSentryEvent(new Error('x'), {}, { source: 'web' });
    const [header, item, body] = buildEnvelope(event, new Date('2026-09-23T10:00:00Z')).split('\n');
    expect(JSON.parse(header!)).toEqual({
      event_id: event.event_id,
      sent_at: '2026-09-23T10:00:00.000Z',
    });
    expect(JSON.parse(item!)).toEqual({
      type: 'event',
      content_type: 'application/json',
      length: new TextEncoder().encode(body!).length,
    });
    expect(JSON.parse(body!).event_id).toBe(event.event_id);
  });
});

describe('createErrorReporter', () => {
  it('does nothing and never touches the network when the DSN is unset or invalid', async () => {
    const { fetch, calls } = fakeFetch();
    const warnings: string[] = [];
    const off = createErrorReporter({ dsn: undefined, source: 'web', fetch });
    expect(off.enabled).toBe(false);
    expect(await off.capture(new Error('x'), { correlationId: 'c' })).toBe('disabled');
    const invalid = createErrorReporter({
      dsn: 'nonsense',
      source: 'web',
      fetch,
      onWarning: (m) => warnings.push(m),
    });
    expect(invalid.enabled).toBe(false);
    expect(await invalid.capture(new Error('x'))).toBe('disabled');
    expect(calls).toHaveLength(0);
    expect(warnings).toEqual(['SENTRY_DSN is not a valid DSN; ignored']);
  });

  it('posts a sanitized envelope to the DSN endpoint with the auth header', async () => {
    const { fetch, calls } = fakeFetch();
    const reporter = createErrorReporter({
      dsn: DSN,
      release: 'abc123',
      environment: 'production',
      source: 'web',
      fetch,
    });
    const err = new Error('failed for ada@example.com with token=secret123');
    expect(
      await reporter.capture(err, {
        correlationId: 'corr-9',
        route: '/api/v1/x/42',
        method: 'GET',
      }),
    ).toBe('sent');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://o123.ingest.sentry.io/api/456/envelope/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth':
        'Sentry sentry_version=7, sentry_client=simplexd-error-reporter/1.0, sentry_key=abc123publickey',
    });
    const { event } = envelopeOf(init);
    expect(event).toMatchObject({
      release: 'abc123',
      environment: 'production',
      transaction: '/api/v1/x/:id',
      tags: { correlation_id: 'corr-9', method: 'GET', source: 'web' },
    });
    expect(event.exception.values[0].value).toBe('failed for [email] with token=[redacted]');
    const raw = String(init.body);
    expect(raw).not.toMatch(/example\.com|secret123|cookie|authorization/i);
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(reporter.stats()).toEqual({ sent: 1, dropped: 0, failed: 0 });
  });

  it('rate limits per rolling minute and honours 429 Retry-After', async () => {
    let t = Date.parse('2026-09-23T10:00:00Z');
    const { fetch, calls } = fakeFetch();
    const reporter = createErrorReporter({
      dsn: DSN,
      source: 'worker',
      fetch,
      maxEventsPerMinute: 2,
      now: () => new Date(t),
    });
    expect(await reporter.capture(new Error('1'))).toBe('sent');
    expect(await reporter.capture(new Error('2'))).toBe('sent');
    expect(await reporter.capture(new Error('3'))).toBe('dropped');
    expect(calls).toHaveLength(2);
    t += 61_000;
    expect(await reporter.capture(new Error('4'))).toBe('sent');

    const limited = fakeFetch(429, { 'retry-after': '120' });
    const paused = createErrorReporter({
      dsn: DSN,
      source: 'worker',
      fetch: limited.fetch,
      now: () => new Date(t),
    });
    expect(await paused.capture(new Error('a'))).toBe('dropped');
    expect(await paused.capture(new Error('b'))).toBe('dropped');
    expect(limited.calls).toHaveLength(1);
    t += 121_000;
    await paused.capture(new Error('c'));
    expect(limited.calls).toHaveLength(2);
  });

  it('swallows failures with a single warning per outage', async () => {
    const warnings: Array<[string, Record<string, unknown>]> = [];
    const failing = fakeFetch(500);
    const reporter = createErrorReporter({
      dsn: DSN,
      source: 'web',
      fetch: failing.fetch,
      onWarning: (m, d) => warnings.push([m, d]),
    });
    expect(await reporter.capture(new Error('x'))).toBe('failed');
    expect(await reporter.capture(new Error('y'))).toBe('failed');
    expect(warnings).toEqual([
      ['error reporting failed; further failures are not logged', { status: 500 }],
    ]);
    const throwing = createErrorReporter({
      dsn: DSN,
      source: 'web',
      fetch: (async () => {
        throw new Error('ECONNRESET token=abc');
      }) as unknown as typeof globalThis.fetch,
      onWarning: (m, d) => warnings.push([m, d]),
    });
    expect(await throwing.capture(new Error('z'))).toBe('failed');
    expect(warnings[1]).toEqual([
      'error reporting failed; further failures are not logged',
      { reason: 'ECONNRESET token=[redacted]' },
    ]);
    expect(reporter.stats().failed).toBe(2);
  });
});

describe('log redaction paths', () => {
  it('covers secrets at three depths and header shapes with bracket notation', () => {
    for (const key of SENSITIVE_LOG_KEYS) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`*.${key}`);
      expect(LOG_REDACT_PATHS).toContain(`*.*.${key}`);
    }
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(LOG_REDACT_PATHS).toContain('*.headers["x-api-key"]');
    expect(SENSITIVE_LOG_KEYS).not.toContain('code');
  });
});

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentRedirectSnapshot,
  resetRedirectSnapshotForTests,
  SNAPSHOT_TTL_MS,
} from '@/lib/redirects/proxy-cache';
import proxy from './proxy';

/**
 * Request policy: per-request CSP nonce, the cross-site request forgery guard
 * for cookie-authenticated APIs, the cheap redirect of private surfaces
 * without a session cookie, and migrated-site redirects served from the
 * in-memory snapshot with their configured HTTP status.
 */

const ORIGIN = 'http://localhost:3000';

function request(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {},
): NextRequest {
  const headers = new Headers(init.headers);
  if (init.cookies)
    headers.set(
      'cookie',
      Object.entries(init.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers });
}

/** Headers the proxy forwards to the app (NextResponse.next({ request: { headers } })). */
function forwardedHeader(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

type SnapshotItem = { from: string; to: string; status: number };

/**
 * Replaces global fetch with a stub of the app's own endpoints the proxy
 * calls: the redirect snapshot and the hit counter. Unit tests never reach
 * the network.
 */
function stubAppFetch(items: SnapshotItem[] = []) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET', body: (init?.body as string) ?? null });
    if (url.endsWith('/api/v1/redirects/snapshot')) {
      return Response.json({ version: `${items.length}:1`, items });
    }
    if (url.endsWith('/api/v1/redirects/hits')) return Response.json({ counted: true });
    return new Response('not stubbed', { status: 500 });
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.APP_URL = ORIGIN;
  process.env.TRUSTED_ORIGINS = '';
  process.env.MAP_TILE_HOSTS = 'tiles.example.test';
  process.env.PUBLIC_MEDIA_HOSTNAMES = '';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
  resetRedirectSnapshotForTests();
  stubAppFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const key of [
    'APP_URL',
    'TRUSTED_ORIGINS',
    'MAP_TILE_HOSTS',
    'PUBLIC_MEDIA_HOSTNAMES',
    'S3_ENDPOINT',
    'INTERNAL_APP_URL',
  ])
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
});

describe('content security policy', () => {
  it('sets a per-request nonce on the response CSP and forwards it to the app', async () => {
    const first = await proxy(request('/'));
    const second = await proxy(request('/'));
    const csp = first.headers.get('content-security-policy')!;
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(Buffer.from(nonce!, 'base64')).toHaveLength(16);
    expect(forwardedHeader(first, 'x-nonce')).toBe(nonce);
    expect(forwardedHeader(first, 'content-security-policy')).toBe(csp);
    expect(forwardedHeader(first, 'x-pathname')).toBe('/');
    const otherNonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(
      second.headers.get('content-security-policy')!,
    )?.[1];
    expect(otherNonce).not.toBe(nonce);
  });

  it('carries the expected directives, allow-listed hosts and no wildcard sources', async () => {
    const csp = (await proxy(request('/locations'))).headers.get('content-security-policy')!;
    const directives = Object.fromEntries(
      csp.split(';').map((d: string) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name, rest.join(' ')];
      }),
    );
    expect(directives['default-src']).toBe("'self'");
    expect(directives['script-src']).toMatch(
      /^'self' 'nonce-[^']+' 'strict-dynamic' https:\/\/js\.paystack\.co/,
    );
    expect(directives['object-src']).toBe("'none'");
    expect(directives['base-uri']).toBe("'self'");
    expect(directives['form-action']).toBe("'self'");
    expect(directives['frame-ancestors']).toBe("'none'");
    expect(directives['img-src']).toContain('https://tiles.example.test');
    expect(directives['img-src']).toContain('http://127.0.0.1:9000');
    expect(directives['connect-src']).toContain('https://api.paystack.co');
    expect(directives['connect-src']).toContain('https://tiles.example.test');
    expect(directives['frame-src']).toBe('https://checkout.paystack.com https://js.paystack.co');
    expect(csp).not.toMatch(/\s\*(\s|;|$)/);
    // Tests run outside production, so the development-only relaxations apply and
    // upgrade-insecure-requests is absent.
    expect(directives['script-src']).toContain("'unsafe-eval'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('issues the anonymous visitor cookie once', async () => {
    const fresh = await proxy(request('/'));
    const setCookie = fresh.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^sx_anon=[0-9a-f]{48};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    const returning = await proxy(request('/', { cookies: { sx_anon: 'a'.repeat(48) } }));
    expect(returning.headers.get('set-cookie')).toBeNull();
  });
});

describe('cross-site request guard', () => {
  const blocked = (res: Response) => res.status === 403;

  it('refuses state-changing API requests marked cross-site by the browser', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await proxy(
        request('/api/v1/leads', { method, headers: { 'sec-fetch-site': 'cross-site' } }),
      );
      expect(blocked(res), method).toBe(true);
    }
    const res = await proxy(
      request('/api/v1/leads', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-site', 'x-correlation-id': 'corr-7' },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'forbidden', message: 'cross-site request blocked', correlationId: 'corr-7' },
    });
  });

  it('allows same-origin and navigation requests, and non-browser clients without either header', async () => {
    const allowed: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      {},
      { 'sec-fetch-site': 'same-origin', origin: ORIGIN },
    ];
    for (const headers of allowed) {
      const res = await proxy(request('/api/v1/leads', { method: 'POST', headers }));
      expect(blocked(res), JSON.stringify(headers)).toBe(false);
    }
  });

  it('accepts an Origin that matches the request, the Host, APP_URL or TRUSTED_ORIGINS and refuses others', async () => {
    process.env.APP_URL = 'https://app.simplexd.test';
    process.env.TRUSTED_ORIGINS = 'https://partner.simplexd.test, https://cms.simplexd.test';
    const post = (origin: string, headers: Record<string, string> = {}) =>
      proxy(request('/api/v1/leads', { method: 'POST', headers: { origin, ...headers } }));
    expect(blocked(await post(ORIGIN))).toBe(false);
    expect(blocked(await post('https://app.simplexd.test'))).toBe(false);
    expect(blocked(await post('https://partner.simplexd.test'))).toBe(false);
    expect(blocked(await post('https://cms.simplexd.test'))).toBe(false);
    // Behind a reverse proxy the browser's Origin matches the forwarded host.
    expect(
      blocked(
        await post('https://www.simplexd.test', {
          'x-forwarded-host': 'www.simplexd.test',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(false);
    expect(blocked(await post('http://127.0.0.1:3000', { host: '127.0.0.1:3000' }))).toBe(false);
    expect(blocked(await post('https://evil.example'))).toBe(true);
    expect(blocked(await post('https://app.simplexd.test.evil.example'))).toBe(true);
    expect(blocked(await post('null'))).toBe(true);
  });

  it('never blocks GET/HEAD, non-API paths or provider webhooks', async () => {
    const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
    expect(
      blocked(await proxy(request('/api/v1/markets', { method: 'GET', headers: cross }))),
    ).toBe(false);
    expect(
      blocked(await proxy(request('/api/v1/markets', { method: 'HEAD', headers: cross }))),
    ).toBe(false);
    expect(blocked(await proxy(request('/sign-in', { method: 'POST', headers: cross })))).toBe(
      false,
    );
    expect(
      blocked(await proxy(request('/api/v1/webhooks/paystack', { method: 'POST', headers: cross }))),
    ).toBe(false);
    expect(
      blocked(await proxy(request('/api/v1/webhooks/termii', { method: 'POST', headers: cross }))),
    ).toBe(false);
    // The exemption is a prefix, not a substring.
    expect(
      blocked(
        await proxy(request('/api/v1/admin/webhooks/replay', { method: 'POST', headers: cross })),
      ),
    ).toBe(true);
  });
});

describe('private surfaces', () => {
  it('redirects to sign-in with the requested path when there is no session cookie', async () => {
    for (const path of ['/portal', '/admin/settings', '/partner/tenders/1', '/tenant']) {
      const res = await proxy(request(`${path}?tab=2`));
      expect(res.status, path).toBe(307);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/sign-in');
      expect(location.searchParams.get('next')).toBe(`${path}?tab=2`);
    }
  });

  it('lets a request with the session cookie through to the app (full authorisation happens server-side)', async () => {
    const res = await proxy(
      request('/portal/requests', { cookies: { 'sx.session_token': 'opaque' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('does not redirect public pages, look-alike paths or API routes', async () => {
    for (const path of ['/', '/locations', '/portals', '/administration', '/api/v1/me']) {
      expect((await proxy(request(path))).status, path).toBe(200);
    }
  });
});

describe('migrated-site redirects', () => {
  const table: SnapshotItem[] = [
    { from: '/services/monitoring', to: '/services/construction-monitoring', status: 301 },
    { from: '/promo', to: '/pricing', status: 302 },
    { from: '/old-form', to: '/book', status: 308 },
    { from: '/legacy-blog', to: 'https://blog.example.test/archive', status: 301 },
    { from: '/with-query', to: '/explore?objective=long_term_rent', status: 301 },
  ];

  it('answers with the configured status and an absolute Location', async () => {
    stubAppFetch(table);
    const permanent = await proxy(request('/services/monitoring'));
    expect(permanent.status).toBe(301);
    expect(permanent.headers.get('location')).toBe(
      `${ORIGIN}/services/construction-monitoring`,
    );
    expect(permanent.headers.get('cache-control')).toBe('public, max-age=300');

    const temporary = await proxy(request('/promo'));
    expect(temporary.status).toBe(302);
    expect(temporary.headers.get('location')).toBe(`${ORIGIN}/pricing`);

    const methodPreserving = await proxy(request('/old-form/'));
    expect(methodPreserving.status).toBe(308);
    expect(methodPreserving.headers.get('location')).toBe(`${ORIGIN}/book`);

    const external = await proxy(request('/legacy-blog'));
    expect(external.status).toBe(301);
    expect(external.headers.get('location')).toBe('https://blog.example.test/archive');
  });

  it('keeps the visitor query string on relative targets that have none', async () => {
    stubAppFetch(table);
    const res = await proxy(request('/services/monitoring?utm_source=newsletter'));
    expect(res.headers.get('location')).toBe(
      `${ORIGIN}/services/construction-monitoring?utm_source=newsletter`,
    );
    const own = await proxy(request('/with-query?utm_source=x'));
    expect(own.headers.get('location')).toBe(`${ORIGIN}/explore?objective=long_term_rent`);
  });

  it('serves the table from memory: one snapshot fetch, then lookups only, and reports hits in the background', async () => {
    const { calls } = stubAppFetch(table);
    const waited: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never;
    await proxy(request('/promo'), event);
    await proxy(request('/services/monitoring'), event);
    await proxy(request('/locations'), event);
    await Promise.all(waited);
    const snapshots = calls.filter((c) => c.url.endsWith('/api/v1/redirects/snapshot'));
    const hits = calls.filter((c) => c.url.endsWith('/api/v1/redirects/hits'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(hits.map((h) => JSON.parse(h.body!).path)).toEqual(['/promo', '/services/monitoring']);
    expect(currentRedirectSnapshot()).toMatchObject({ size: table.length });
  });

  it('refreshes a stale snapshot in the background and honours INTERNAL_APP_URL', async () => {
    process.env.INTERNAL_APP_URL = 'http://web:3000/';
    const { calls } = stubAppFetch(table);
    vi.useFakeTimers({ toFake: ['Date'] });
    await proxy(request('/promo'));
    vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 1);
    const waited: Promise<unknown>[] = [];
    const res = await proxy(request('/promo'), {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    // The stale table still answered immediately…
    expect(res.status).toBe(302);
    await Promise.all(waited);
    // …and was refreshed once in the background, from the configured internal URL.
    const snapshots = calls.filter((c) => c.url.endsWith('/api/v1/redirects/snapshot'));
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((c) => c.url.startsWith('http://web:3000/api/'))).toBe(true);
  });

  it('never redirects API paths, non-GET requests or paths not in the table, and passes through when the snapshot is unavailable', async () => {
    stubAppFetch([{ from: '/api/v1/markets', to: '/x', status: 301 }, ...table]);
    expect((await proxy(request('/api/v1/markets'))).status).toBe(200);
    expect((await proxy(request('/promo', { method: 'POST' }))).status).toBe(200);
    expect((await proxy(request('/not-in-table'))).status).toBe(200);

    resetRedirectSnapshotForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const res = await proxy(request('/promo'));
    expect(res.status).toBe(200);
    // The path still reaches the app so the not-found boundary can fall back to the database.
    expect(forwardedHeader(res, 'x-pathname')).toBe('/promo');
  });
});

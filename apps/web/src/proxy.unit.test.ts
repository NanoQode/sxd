import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import proxy from './proxy';

/**
 * Edge-side request policy: per-request CSP nonce, the cross-site request
 * forgery guard for cookie-authenticated APIs, and the cheap redirect of
 * private surfaces without a session cookie.
 */

const ORIGIN = 'http://localhost:3000';

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {},
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

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.APP_URL = ORIGIN;
  process.env.TRUSTED_ORIGINS = '';
  process.env.MAP_TILE_HOSTS = 'tiles.example.test';
  process.env.PUBLIC_MEDIA_HOSTNAMES = '';
  process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
});
afterEach(() => {
  for (const key of ['APP_URL', 'TRUSTED_ORIGINS', 'MAP_TILE_HOSTS', 'PUBLIC_MEDIA_HOSTNAMES', 'S3_ENDPOINT'])
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
});

describe('content security policy', () => {
  it('sets a per-request nonce on the response CSP and forwards it to the app', () => {
    const first = proxy(request('/'));
    const second = proxy(request('/'));
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

  it('carries the expected directives, allow-listed hosts and no wildcard sources', () => {
    const csp = proxy(request('/locations')).headers.get('content-security-policy')!;
    const directives = Object.fromEntries(
      csp.split(';').map((d) => {
        const [name, ...rest] = d.trim().split(/\s+/);
        return [name, rest.join(' ')];
      }),
    );
    expect(directives["default-src"]).toBe("'self'");
    expect(directives['script-src']).toMatch(/^'self' 'nonce-[^']+' 'strict-dynamic' https:\/\/js\.paystack\.co/);
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

  it('issues the anonymous visitor cookie once', () => {
    const fresh = proxy(request('/'));
    const setCookie = fresh.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^sx_anon=[0-9a-f]{48};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    const returning = proxy(request('/', { cookies: { sx_anon: 'a'.repeat(48) } }));
    expect(returning.headers.get('set-cookie')).toBeNull();
  });
});

describe('cross-site request guard', () => {
  const blocked = (res: Response) => res.status === 403;

  it('refuses state-changing API requests marked cross-site by the browser', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = proxy(
        request('/api/v1/leads', { method, headers: { 'sec-fetch-site': 'cross-site' } }),
      );
      expect(blocked(res), method).toBe(true);
    }
    const res = proxy(
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

  it('allows same-origin and navigation requests, and non-browser clients without either header', () => {
    for (const headers of [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      {},
      { 'sec-fetch-site': 'same-origin', origin: ORIGIN },
    ]) {
      const res = proxy(request('/api/v1/leads', { method: 'POST', headers }));
      expect(blocked(res), JSON.stringify(headers)).toBe(false);
    }
  });

  it('accepts an Origin that matches the request, the Host, APP_URL or TRUSTED_ORIGINS and refuses others', () => {
    process.env.APP_URL = 'https://app.simplexd.test';
    process.env.TRUSTED_ORIGINS = 'https://partner.simplexd.test, https://cms.simplexd.test';
    const post = (origin: string, headers: Record<string, string> = {}) =>
      proxy(request('/api/v1/leads', { method: 'POST', headers: { origin, ...headers } }));
    expect(blocked(post(ORIGIN))).toBe(false);
    expect(blocked(post('https://app.simplexd.test'))).toBe(false);
    expect(blocked(post('https://partner.simplexd.test'))).toBe(false);
    expect(blocked(post('https://cms.simplexd.test'))).toBe(false);
    // Behind a reverse proxy the browser's Origin matches the forwarded host.
    expect(
      blocked(
        post('https://www.simplexd.test', {
          'x-forwarded-host': 'www.simplexd.test',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(false);
    expect(blocked(post('http://127.0.0.1:3000', { host: '127.0.0.1:3000' }))).toBe(false);
    expect(blocked(post('https://evil.example'))).toBe(true);
    expect(blocked(post('https://app.simplexd.test.evil.example'))).toBe(true);
    expect(blocked(post('null'))).toBe(true);
  });

  it('never blocks GET/HEAD, non-API paths or provider webhooks', () => {
    const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
    expect(blocked(proxy(request('/api/v1/markets', { method: 'GET', headers: cross })))).toBe(false);
    expect(blocked(proxy(request('/api/v1/markets', { method: 'HEAD', headers: cross })))).toBe(false);
    expect(blocked(proxy(request('/sign-in', { method: 'POST', headers: cross })))).toBe(false);
    expect(blocked(proxy(request('/api/v1/webhooks/paystack', { method: 'POST', headers: cross })))).toBe(false);
    expect(blocked(proxy(request('/api/v1/webhooks/termii', { method: 'POST', headers: cross })))).toBe(false);
    // The exemption is a prefix, not a substring.
    expect(blocked(proxy(request('/api/v1/admin/webhooks/replay', { method: 'POST', headers: cross })))).toBe(true);
  });
});

describe('private surfaces', () => {
  it('redirects to sign-in with the requested path when there is no session cookie', () => {
    for (const path of ['/portal', '/admin/settings', '/partner/tenders/1', '/tenant']) {
      const res = proxy(request(`${path}?tab=2`));
      expect(res.status, path).toBe(307);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/sign-in');
      expect(location.searchParams.get('next')).toBe(`${path}?tab=2`);
    }
  });

  it('lets a request with the session cookie through to the app (full authorisation happens server-side)', () => {
    const res = proxy(request('/portal/requests', { cookies: { 'sx.session_token': 'opaque' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('does not redirect public pages, look-alike paths or API routes', () => {
    for (const path of ['/', '/locations', '/portals', '/administration', '/api/v1/me']) {
      expect(proxy(request(path)).status, path).toBe(200);
    }
  });
});

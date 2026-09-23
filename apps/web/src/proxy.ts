import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import {
  isRedirectCandidate,
  lookupRedirect,
  redirectLocation,
  reportRedirectHit,
  type SnapshotSource,
} from '@/lib/redirects/proxy-cache';

/**
 * Request policy (Node runtime proxy, runs before every route):
 * - Content Security Policy with a per-request nonce (scripts) and allow-listed
 *   map tile, payment and storage hosts.
 * - Anonymous visitor token cookie for saved scenarios before sign-up.
 * - Cheap gating of private surfaces: no session cookie means redirect to
 *   sign-in (full authorisation happens server-side in each layout/route).
 * - Migrated-site redirects with their configured status (301/302/308) from an
 *   in-memory snapshot of the redirect table (see lib/redirects/proxy-cache):
 *   one Map lookup per navigation, refreshed in the background every 30 s
 *   through the app's own snapshot route, never a database query here.
 *   Redirect sources can only be paths that are not live pages (enforced when
 *   redirects are created), so the app's own routes are never shadowed.
 */

const PRIVATE_PREFIXES = ['/portal', '/admin', '/partner', '/tenant'];

/**
 * Where the proxy reaches this deployment for its snapshot refresh: the
 * process itself by default (standalone server behind Caddy), overridable for
 * other topologies.
 */
function snapshotSource(request: NextRequest): SnapshotSource {
  const baseUrl =
    process.env.INTERNAL_APP_URL?.replace(/\/$/, '') ??
    `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
  return { baseUrl, host: request.headers.get('host') };
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function anonymousToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function csp(n: string, isDev: boolean): string {
  const tileHosts = (process.env.MAP_TILE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (h.startsWith('http') ? h : `https://${h}`));
  const mediaHosts = (process.env.PUBLIC_MEDIA_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => `https://${h}`);
  const s3 = process.env.S3_ENDPOINT ? [process.env.S3_ENDPOINT] : [];
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${n}' 'strict-dynamic' https://js.paystack.co${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `img-src 'self' data: blob: ${[...tileHosts, ...mediaHosts, ...s3].join(' ')}`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `connect-src 'self' https://api.paystack.co ${[...tileHosts, ...s3].join(' ')}${isDev ? ' ws: wss:' : ''}`,
    `worker-src 'self' blob:`,
    `child-src blob:`,
    `frame-src https://checkout.paystack.com https://js.paystack.co`,
    `media-src 'self' blob: ${s3.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (!isDev) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Provider callbacks are authenticated by signature, not by cookie. */
const CSRF_EXEMPT_PREFIXES = ['/api/v1/webhooks/'];

/**
 * Cross-site request forgery guard for cookie-authenticated JSON APIs. Browsers
 * send `Sec-Fetch-Site` (and `Origin` on state-changing requests); a value other
 * than same-origin/none, or an Origin that is not this deployment, is refused.
 * Requests without either header come from non-browser clients, which cannot
 * carry the victim's cookies, so they pass through to normal authentication.
 */
function isCrossSite(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([request.nextUrl.origin]);
  // A browser cannot set Host on a cross-site request, so an Origin matching
  // the host it addressed is same-site even when the server knows itself by
  // another name (a reverse proxy, 127.0.0.1 versus localhost).
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
      request.nextUrl.protocol.replace(':', '');
    allowed.add(`${proto}://${host}`);
  }
  for (const configured of [
    process.env.APP_URL,
    ...(process.env.TRUSTED_ORIGINS ?? '').split(','),
  ]) {
    if (!configured?.trim()) continue;
    try {
      allowed.add(new URL(configured.trim()).origin);
    } catch {
      /* ignore malformed configuration; the request origin still counts */
    }
  }
  return !allowed.has(origin);
}

export default async function proxy(request: NextRequest, event?: NextFetchEvent) {
  const isDev = process.env.NODE_ENV !== 'production';
  const n = nonce();
  const policy = csp(n, isDev);

  // Migrated-site redirects: served with the configured status before any route runs.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    isRedirectCandidate(request.nextUrl.pathname)
  ) {
    const source = snapshotSource(request);
    const waitUntil = event ? (p: Promise<unknown>) => event.waitUntil(p) : undefined;
    const match = await lookupRedirect(request.nextUrl.pathname, source, waitUntil);
    if (match) {
      const location = redirectLocation(match, request.nextUrl);
      const hit = reportRedirectHit(
        request.nextUrl.pathname,
        source,
        request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip'),
      );
      if (waitUntil) waitUntil(hit);
      const response = NextResponse.redirect(location, match.status);
      response.headers.set('cache-control', 'public, max-age=300');
      return response;
    }
  }

  if (
    STATE_CHANGING.has(request.method) &&
    request.nextUrl.pathname.startsWith('/api/') &&
    !CSRF_EXEMPT_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p)) &&
    isCrossSite(request)
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'forbidden',
          message: 'cross-site request blocked',
          correlationId: request.headers.get('x-correlation-id') ?? 'csrf',
        },
      },
      { status: 403 },
    );
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', n);
  requestHeaders.set('content-security-policy', policy);

  const { pathname } = request.nextUrl;
  // Lets layouts read the requested path, and the not-found boundary fall back
  // to a database redirect lookup when the proxy snapshot was unavailable.
  requestHeaders.set('x-pathname', pathname);
  const secure = request.nextUrl.protocol === 'https:';
  const sessionCookie = request.cookies.get(
    secure ? '__Secure-sx.session_token' : 'sx.session_token',
  );

  if (
    PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) &&
    !sessionCookie
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  if (!request.cookies.get('sx_anon')) {
    response.cookies.set('sx_anon', anonymousToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  matcher: [
    // Skip static assets, Next internals and public media bytes (/media/{id}
    // sets its own headers and must not carry cookies or a CSP nonce); API
    // routes get CSP too (harmless) but never redirects.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icons/|images/|media/).*)',
  ],
};

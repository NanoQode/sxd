import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge-side request policy:
 * - Content Security Policy with a per-request nonce (scripts) and allow-listed
 *   map tile, payment and storage hosts.
 * - Anonymous visitor token cookie for saved scenarios before sign-up.
 * - Cheap gating of private surfaces: no session cookie means redirect to
 *   sign-in (full authorisation happens server-side in each layout/route).
 */

const PRIVATE_PREFIXES = ['/portal', '/admin', '/partner', '/tenant'];

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

export default function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== 'production';
  const n = nonce();
  const policy = csp(n, isDev);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', n);
  requestHeaders.set('content-security-policy', policy);

  const { pathname } = request.nextUrl;
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
    // Skip static assets and Next internals; API routes get CSP too (harmless) but not redirects.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icons/|images/).*)',
  ],
};

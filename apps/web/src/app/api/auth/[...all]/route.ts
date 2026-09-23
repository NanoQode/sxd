import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

const handler = toNextJsHandler(auth);

/**
 * The auth library's admin plugin stays loaded only so banned accounts cannot
 * sign in. Its HTTP endpoints (list, ban, set role, impersonate...) would
 * bypass SimplexD's staff permissions, MFA, reasons and audit trail, so they
 * are never served; staff administration goes through /api/v1/admin/*.
 */
function refuseAdminPlugin(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/auth/admin' || pathname.startsWith('/api/auth/admin/')) {
    return Response.json(
      { error: { code: 'not_found', message: 'not found', correlationId: 'auth-admin' } },
      { status: 404 },
    );
  }
  return null;
}

export async function GET(request: Request) {
  return refuseAdminPlugin(request) ?? handler.GET(request);
}

export async function POST(request: Request) {
  return refuseAdminPlugin(request) ?? handler.POST(request);
}

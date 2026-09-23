import { NextResponse } from 'next/server';
import { ApiError } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { route } from '@/lib/api/respond';
import { env } from '@/lib/env';
import { OAUTH_COOKIE, completeConnect } from '@/server/calendar/oauth';

export const dynamic = 'force-dynamic';

const ADMIN_PAGE = '/admin/integrations/google-workspace';

/**
 * GET /api/v1/calendar/callback — Google (or the development adapter) returns
 * here with `code` and `state`. Tokens are exchanged server-side and stored
 * encrypted; the browser is sent back to the admin page with the outcome.
 */
export const GET = route(async (req, { correlationId }) => {
  const url = new URL(req.url);
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookieValue =
    cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${OAUTH_COOKIE}=`))
      ?.slice(OAUTH_COOKIE.length + 1) ?? null;
  const target = new URL(ADMIN_PAGE, env().APP_URL);
  let res: NextResponse;
  try {
    const result = await completeConnect(identity, {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      cookieValue: cookieValue ? decodeURIComponent(cookieValue) : null,
      correlationId,
    });
    target.searchParams.set('calendar', result.connection.status);
    if (result.missingScopes.length > 0)
      target.searchParams.set('missingScopes', result.missingScopes.join(' '));
    res = NextResponse.redirect(target, { status: 302 });
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'connection failed';
    target.searchParams.set('calendar', 'error');
    target.searchParams.set('message', message.slice(0, 300));
    res = NextResponse.redirect(target, { status: 302 });
  }
  res.cookies.set({ name: OAUTH_COOKIE, value: '', path: '/api/v1/calendar', maxAge: 0 });
  return res;
});

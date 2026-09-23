import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireStaff } from '@/lib/auth/session';
import { json, parseQuery, route } from '@/lib/api/respond';
import { env } from '@/lib/env';
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE_SECONDS, startConnect } from '@/server/calendar/oauth';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  calendarId: z.string().max(256).optional(),
  /** `1` redirects the browser to Google immediately instead of returning JSON. */
  redirect: z.enum(['0', '1']).default('0'),
});

/**
 * GET /api/v1/calendar/connect — begin the organiser OAuth grant (PKCE + signed
 * state). Requires appointments.manage_all. The pending verifier is kept in a
 * short-lived HttpOnly cookie bound to this session.
 */
export const GET = route(async (req, { correlationId }) => {
  const identity = await requireStaff('appointments.manage_all');
  const query = parseQuery(req, querySchema);
  const start = await startConnect(identity, { calendarId: query.calendarId ?? null });
  const res =
    query.redirect === '1'
      ? NextResponse.redirect(start.authorizationUrl, { status: 302 })
      : json(
          { authorizationUrl: start.authorizationUrl, adapter: start.adapter },
          { correlationId },
        );
  res.cookies.set({
    name: OAUTH_COOKIE,
    value: start.cookieValue,
    httpOnly: true,
    sameSite: 'lax',
    secure: env().APP_URL.startsWith('https://'),
    path: '/api/v1/calendar',
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
});

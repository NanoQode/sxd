import { sql } from 'drizzle-orm';
import { getDb, queueDepth } from '@simplexd/db';
import { env } from '@/lib/env';
import { json, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness. Public response is minimal; queue details require
 * HEALTH_TOKEN so uptime monitors can watch lag without exposing internals.
 */
export const GET = route(async (req, { correlationId }) => {
  const e = env();
  const started = Date.now();
  let database: 'ok' | 'error' = 'ok';
  let details: Record<string, unknown> = {};
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    const token =
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      new URL(req.url).searchParams.get('token');
    if (e.HEALTH_TOKEN && token === e.HEALTH_TOKEN) {
      details = { queue: await queueDepth(db) };
    }
  } catch {
    database = 'error';
  }
  const ok = database === 'ok';
  return json(
    {
      ok,
      service: 'web',
      env: e.APP_ENV,
      database,
      latencyMs: Date.now() - started,
      version: process.env.APP_VERSION ?? 'dev',
      ...details,
    },
    { status: ok ? 200 : 503, correlationId },
  );
});

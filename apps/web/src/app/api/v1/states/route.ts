import { getIdentity } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listStatesWithCounts } from '@/server/markets/queries';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** GET /api/v1/states: every state with the number of markets visible to the caller. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await getIdentity();
  const items = await listStatesWithCounts(identity);
  return json({ items }, { correlationId, headers: { 'cache-control': 'public, max-age=60' } });
});

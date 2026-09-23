import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { disconnectConnection } from '@/server/calendar/oauth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ connectionId: uuidSchema });

/** POST /api/v1/calendar/disconnect — revoke the grant, retire the encrypted tokens, stop push channels. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await requireStaff('appointments.manage_all');
  const body = await parseJson(req, bodySchema);
  return json(await disconnectConnection(identity, body.connectionId, { correlationId }), { correlationId });
});

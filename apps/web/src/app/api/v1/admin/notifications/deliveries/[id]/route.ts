import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { deliveryDetail } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/notifications/deliveries/:id — one attempt (masked) with its
 * timeline. notifications.templates.manage sees every attempt; holders of only
 * notifications.test_send see test attempts (to follow their own test sends).
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await deliveryDetail(adminContext(identity, ctx.correlationId), id), {
    correlationId: ctx.correlationId,
  });
});

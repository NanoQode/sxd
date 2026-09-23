import { z } from 'zod';
import { devReceiptSimulateSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { simulateReceipt } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/deliveries/:id/simulate-receipt — development
 * adapter only (404 in production): builds a signed Termii-shaped delivery
 * report for an accepted development SMS and runs it through the real webhook
 * handler, so accepted → delivered/failed can be seen without a provider.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('notifications.test_send');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, devReceiptSimulateSchema);
  const result = await simulateReceipt(adminContext(identity, ctx.correlationId), id, body.state);
  return json(result, { correlationId: ctx.correlationId });
});

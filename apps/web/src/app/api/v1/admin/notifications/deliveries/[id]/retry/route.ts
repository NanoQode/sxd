import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { retryDelivery } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/notifications/deliveries/:id/retry — re-send a failed or
 * rejected attempt as one linked attempt. Idempotent: repeating the request
 * returns the existing retry (`created: false`) and sends nothing. Audited.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('notifications.templates.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const result = await retryDelivery(adminContext(identity, ctx.correlationId), id);
  return json(result, { status: result.created ? 201 : 200, correlationId: ctx.correlationId });
});

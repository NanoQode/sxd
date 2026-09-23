import { z } from 'zod';
import { ApiError, leaseMilestoneUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { updateLeaseMilestone } from '@/server/listings/transactions';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/listings/:id/lease-milestones/:itemId — move a milestone (expectedVersion). */
export const PATCH = route<{ params: Promise<{ id: string; itemId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, itemId } = await params(ctx, z.object({ id: uuidSchema, itemId: uuidSchema }));
    const body = await parseJson(req, leaseMilestoneUpdateSchema);
    return json(
      await updateLeaseMilestone(identity, id, itemId, body, { correlationId: ctx.correlationId }),
      { correlationId: ctx.correlationId },
    );
  },
);

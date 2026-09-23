import { z } from 'zod';
import { ApiError, uuidSchema, unitUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { deleteUnit, updateUnit } from '@/server/properties/units';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/properties/:id/units/:unitId */
export const PATCH = route<{ params: Promise<{ id: string; unitId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, unitId } = await params(ctx, z.object({ id: uuidSchema, unitId: uuidSchema }));
    const body = await parseJson(req, unitUpdateSchema);
    return json(
      await updateUnit(identity, id, unitId, body, { correlationId: ctx.correlationId }),
      { correlationId: ctx.correlationId },
    );
  },
);

/** DELETE /api/v1/properties/:id/units/:unitId */
export const DELETE = route<{ params: Promise<{ id: string; unitId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, unitId } = await params(ctx, z.object({ id: uuidSchema, unitId: uuidSchema }));
    await deleteUnit(identity, id, unitId, { correlationId: ctx.correlationId });
    return new Response(null, { status: 204 });
  },
);

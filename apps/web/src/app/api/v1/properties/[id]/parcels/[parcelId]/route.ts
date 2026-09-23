import { z } from 'zod';
import { ApiError, uuidSchema, parcelUpdateSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { deleteParcel, updateParcel } from '@/server/properties/parcels';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** PATCH /api/v1/properties/:id/parcels/:parcelId */
export const PATCH = route<{ params: Promise<{ id: string; parcelId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, parcelId } = await params(ctx, z.object({ id: uuidSchema, parcelId: uuidSchema }));
    const body = await parseJson(req, parcelUpdateSchema);
    return json(
      await updateParcel(identity, id, parcelId, body, { correlationId: ctx.correlationId }),
      { correlationId: ctx.correlationId },
    );
  },
);

/** DELETE /api/v1/properties/:id/parcels/:parcelId */
export const DELETE = route<{ params: Promise<{ id: string; parcelId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, parcelId } = await params(ctx, z.object({ id: uuidSchema, parcelId: uuidSchema }));
    await deleteParcel(identity, id, parcelId, { correlationId: ctx.correlationId });
    return new Response(null, { status: 204 });
  },
);

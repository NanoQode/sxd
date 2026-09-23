import { z } from 'zod';
import { ApiError, listingUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getListingDetail, reviseListing } from '@/server/listings/owner';
import '@/lib/api/registry/listings';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const idParams = z.object({ id: uuidSchema });

/** GET /api/v1/listings/:id — listing with its current and published revisions. */
export const GET = route<Ctx>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  return json(await getListingDetail(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/listings/:id — save a new revision (expectedVersion guards concurrent edits). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, idParams);
  const body = await parseJson(req, listingUpdateSchema);
  return json(await reviseListing(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

import { z } from 'zod';
import { ApiError, uuidSchema, ownerAuthorityRejectSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { rejectOwnerAuthority } from '@/server/properties/owner-authorities';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** POST /api/v1/properties/:id/owner-authorities/:authorityId/reject — staff with rentals.manage. */
export const POST = route<{ params: Promise<{ id: string; authorityId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, authorityId } = await params(
      ctx,
      z.object({ id: uuidSchema, authorityId: uuidSchema }),
    );
    const body = await parseJson(req, ownerAuthorityRejectSchema);
    return json(
      await rejectOwnerAuthority(identity, id, authorityId, body, {
        correlationId: ctx.correlationId,
      }),
      { correlationId: ctx.correlationId },
    );
  },
);

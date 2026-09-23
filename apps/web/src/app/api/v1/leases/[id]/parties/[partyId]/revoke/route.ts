import { z } from 'zod';
import { ApiError, uuidSchema, leasePartyRevokeSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { revokeParty } from '@/server/rentals/leases';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
export const POST = route<{ params: Promise<{ id: string; partyId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
    const { id, partyId } = await params(ctx, z.object({ id: uuidSchema, partyId: uuidSchema }));
    const body = await parseJson(req, leasePartyRevokeSchema);
    return json(
      await revokeParty(identity, id, partyId, body, { correlationId: ctx.correlationId }),
      { correlationId: ctx.correlationId },
    );
  },
);

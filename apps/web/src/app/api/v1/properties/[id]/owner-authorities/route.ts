import { z } from 'zod';
import { ApiError, uuidSchema, ownerAuthoritySubmitSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { listOwnerAuthorities, submitOwnerAuthority } from '@/server/properties/owner-authorities';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/properties/:id/owner-authorities */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(
    { items: await listOwnerAuthorities(identity, id) },
    { correlationId: ctx.correlationId },
  );
});

/** POST /api/v1/properties/:id/owner-authorities — submit proof of authority to act for the owner. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, ownerAuthoritySubmitSchema);
  return json(
    await submitOwnerAuthority(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});

import { z } from 'zod';
import { ApiError, serviceRequestNoteCreateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { addCustomerNote } from '@/server/requests/notes';

export const dynamic = 'force-dynamic';

/** POST /api/v1/service-requests/:id/notes — a customer-visible note on the request. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, serviceRequestNoteCreateSchema);
  const note = await addCustomerNote(identity, id, body.body);
  return json(note, { status: 201, correlationId: ctx.correlationId });
});

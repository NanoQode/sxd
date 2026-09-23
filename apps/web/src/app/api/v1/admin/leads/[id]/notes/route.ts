import { z } from 'zod';
import { leadNoteCreateSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { addLeadNote } from '@/server/leads/admin';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/leads/:id/notes — internal note (never visible to customers). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('leads.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, leadNoteCreateSchema);
  return json(await addLeadNote(identity, id, body.body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});

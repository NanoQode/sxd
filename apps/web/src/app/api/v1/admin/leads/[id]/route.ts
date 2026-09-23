import { z } from 'zod';
import { leadUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getLeadDetail, updateLead } from '@/server/leads/admin';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });

/** GET /api/v1/admin/leads/:id — lead with context, internal notes and links (leads.read). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await requireStaff('leads.read');
  const { id } = await params(ctx, idSchema);
  return json(await getLeadDetail(identity, id), { correlationId: ctx.correlationId });
});

/** PATCH /api/v1/admin/leads/:id — status change and/or assignment with an optional note (leads.manage). */
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('leads.manage');
  const { id } = await params(ctx, idSchema);
  const body = await parseJson(req, leadUpdateSchema);
  return json(await updateLead(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

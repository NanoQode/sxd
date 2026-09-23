import { z } from 'zod';
import { leadConvertSchema, uuidSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { convertLead } from '@/server/leads/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/admin/leads/:id/convert — creates a service request when the
 * lead's email belongs to a customer organisation member, otherwise queues an
 * invitation email (outbox event lead.invited) and marks the lead contacted.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await requireStaff('leads.manage');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, leadConvertSchema);
  return json(await convertLead(identity, id, body, { correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

import { z } from 'zod';
import { engagementItemEvidenceSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { attachEngagementItemEvidence } from '@/server/engagements/items';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** POST /api/v1/engagement-items/:id/evidence — attach files the caller may use as evidence. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, engagementItemEvidenceSchema);
  return json(
    await attachEngagementItemEvidence(identity, id, body, { correlationId: ctx.correlationId }),
    { correlationId: ctx.correlationId },
  );
});

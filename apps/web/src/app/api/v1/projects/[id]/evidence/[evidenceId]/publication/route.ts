import { z } from 'zod';
import { evidencePublicationUpdateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { setEvidencePublication } from '@/server/projects/evidence';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; evidenceId: string }> }>(
  async (req, ctx) => {
    const identity = await getIdentity();
    const { id, evidenceId } = await params(
      ctx,
      z.object({ id: uuidSchema, evidenceId: uuidSchema }),
    );
    const body = await parseJson(req, evidencePublicationUpdateSchema);
    return json(
      await setEvidencePublication(identity, id, evidenceId, body, {
        correlationId: ctx.correlationId,
      }),
      { status: 200, correlationId: ctx.correlationId },
    );
  },
);

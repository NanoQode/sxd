import { z } from 'zod';
import { jobRetrySchema, uuidSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { retryJob } from '@/server/admin/operations/jobs';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

const jobParams = z.object({ jobId: uuidSchema });

/** POST /api/v1/admin/jobs/:jobId/retry — put a dead job back on the queue; audited, MFA-gated platform.settings.manage (honours Idempotency-Key). */
export const POST = route<{ params: Promise<{ jobId: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { jobId } = await params(ctx, jobParams);
  const body = await parseJson(req, jobRetrySchema);
  return withIdempotency(
    req,
    admin.identity,
    `POST /api/v1/admin/jobs/${jobId}/retry`,
    body,
    async () =>
      json(await retryJob(admin, jobId, body.reason), { correlationId: ctx.correlationId }),
  );
});

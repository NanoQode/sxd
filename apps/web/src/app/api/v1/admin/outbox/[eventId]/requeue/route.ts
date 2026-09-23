import { z } from 'zod';
import { outboxRequeueSchema } from '@simplexd/contracts';
import { withIdempotency } from '@/lib/api/idempotency';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { requeueOutboxEvent } from '@/server/admin/operations/jobs';
import '@/lib/api/registry/admin-market-data';

export const dynamic = 'force-dynamic';

const eventParams = z.object({
  eventId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** POST /api/v1/admin/outbox/:eventId/requeue — reset attempts and error of an unpublished event; audited, MFA-gated platform.settings.manage (honours Idempotency-Key). */
export const POST = route<{ params: Promise<{ eventId: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { eventId } = await params(ctx, eventParams);
  const body = await parseJson(req, outboxRequeueSchema);
  return withIdempotency(
    req,
    admin.identity,
    `POST /api/v1/admin/outbox/${eventId}/requeue`,
    body,
    async () =>
      json(await requeueOutboxEvent(admin, eventId, body.reason), {
        correlationId: ctx.correlationId,
      }),
  );
});

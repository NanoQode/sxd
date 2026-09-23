import { z } from 'zod';
import { serviceRequestReportCreateSchema, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import {
  createServiceRequestReport,
  listServiceRequestReports,
} from '@/server/engagements/reports';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/** GET /api/v1/service-requests/:id/reports — reports linked to the request (customers: released). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  return json(await listServiceRequestReports(identity, id), {
    correlationId: ctx.correlationId,
  });
});

/** POST /api/v1/service-requests/:id/reports — draft a memorandum or inspection report from the template. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, serviceRequestReportCreateSchema);
  return json(
    await createServiceRequestReport(identity, id, body, { correlationId: ctx.correlationId }),
    { status: 201, correlationId: ctx.correlationId },
  );
});

import { rentInvoicingRunInputSchema } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { runRentInvoicing } from '@/server/rentals/jobs';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';

/** POST /api/v1/rent/invoicing-runs — staff `rentals.manage`: run the rent job now (same steps as the hourly job). */
export const POST = route(async (req, ctx) => {
  await requireStaff('rentals.manage');
  const body = await parseJson(req, rentInvoicingRunInputSchema);
  return json(await runRentInvoicing(getDb(), { ...body, correlationId: ctx.correlationId }), {
    correlationId: ctx.correlationId,
  });
});

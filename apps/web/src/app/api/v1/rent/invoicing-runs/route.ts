import { z } from 'zod';
import { ApiError, uuidSchema, dateOnlySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { requireStaff } from '@/lib/auth/session';
import { getDb } from '@simplexd/db';
import { runRentInvoicing } from '@/server/rentals/schedules';
import '@/lib/api/registry/rentals';

export const dynamic = 'force-dynamic';
/** POST /api/v1/rent/invoicing-runs — staff `rentals.manage`: run the due-rent invoicing job now. */
export const POST = route(async (req, ctx) => {
  await requireStaff('rentals.manage');
  const body = await parseJson(req, z.object({ asOf: dateOnlySchema.optional(), leadDays: z.number().int().min(0).max(90).optional() }));
  return json(await runRentInvoicing(getDb(), { ...body, correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});

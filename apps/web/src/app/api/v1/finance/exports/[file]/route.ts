import { NextResponse } from 'next/server';
import { z } from 'zod';
import { allocationsExportQuerySchema, correlationIdHeader } from '@simplexd/contracts';
import { exportAllocations, toCsv } from '@simplexd/finance';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { financeContext } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const fileParams = z.object({ file: z.enum(['allocations.csv', 'allocations.json']) });

/** GET /api/v1/finance/exports/allocations.{csv|json} — staff `finance.export`: allocations with receipts and journal totals. */
export const GET = route<{ params: Promise<{ file: string }> }>(async (req, ctx) => {
  const { rt, fa } = await financeContext(req, ctx.correlationId);
  const { file } = await params(ctx, fileParams);
  const query = parseQuery(req, allocationsExportQuerySchema);
  const rows = await exportAllocations(rt, fa, query);
  const stamp = new Date().toISOString().slice(0, 10);
  if (file.endsWith('.json')) {
    return json(
      { kind: 'allocations', generatedAt: new Date().toISOString(), filters: query, rows },
      { correlationId: ctx.correlationId, headers: { 'content-disposition': `attachment; filename="simplexd-allocations-${stamp}.json"` } },
    );
  }
  return new NextResponse(toCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="simplexd-allocations-${stamp}.csv"`,
      'cache-control': 'no-store',
      [correlationIdHeader]: ctx.correlationId,
    },
  });
});

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, correlationIdHeader, exportQuerySchema } from '@simplexd/contracts';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { exportMarkets, exportObservations, toCsv } from '@/server/admin/market-data/exports';

export const dynamic = 'force-dynamic';

const fileParams = z.object({
  file: z.enum(['markets.json', 'markets.csv', 'observations.json', 'observations.csv']),
});

/** GET /api/v1/admin/exports/{markets|observations}.{json|csv} — data with provenance columns. */
export const GET = route<{ params: Promise<{ file: string }> }>(async (req, ctx) => {
  const admin = await requireAdminContext(ctx.correlationId);
  const { file } = await params(ctx, fileParams);
  const query = parseQuery(req, exportQuerySchema);
  const [kind, format] = file.split('.') as ['markets' | 'observations', 'json' | 'csv'];
  const rows = kind === 'markets' ? await exportMarkets(admin, query) : await exportObservations(admin, query);
  if (rows.length > 50_000) throw new ApiError('validation_failed', 'export too large; narrow the filters');
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    return json(
      { kind, generatedAt: new Date().toISOString(), filters: query, rows },
      {
        correlationId: ctx.correlationId,
        headers: { 'content-disposition': `attachment; filename="simplexd-${kind}-${stamp}.json"` },
      },
    );
  }
  return new NextResponse(toCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="simplexd-${kind}-${stamp}.csv"`,
      'cache-control': 'no-store',
      [correlationIdHeader]: ctx.correlationId,
    },
  });
});

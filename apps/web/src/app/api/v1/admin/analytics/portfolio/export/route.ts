import { NextResponse } from 'next/server';
import { correlationIdHeader, portfolioExportQuerySchema } from '@simplexd/contracts';
import { parseQuery, route } from '@/lib/api/respond';
import { requireAdminContext } from '@/server/admin/http';
import { exportPortfolioSection } from '@/server/admin/analytics/portfolio';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/analytics/portfolio/export?section= — the underlying rows of one section as CSV (finance sections need finance.export). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, portfolioExportQuerySchema);
  const file = await exportPortfolioSection(ctx, query);
  return new NextResponse(file.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
      [correlationIdHeader]: correlationId,
    },
  });
});

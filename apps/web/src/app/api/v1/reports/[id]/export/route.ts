import { z } from 'zod';
import { correlationIdHeader, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { params, parseQuery, route } from '@/lib/api/respond';
import { exportReleasedReport } from '@/server/engagements/reports';
import '@/lib/api/registry/diligence';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/reports/:id/export — print-ready HTML of the released version.
 * Same authorisation as reading the released report; audited. The document
 * carries its own strict policy (no scripts, no external resources) on top
 * of the site policy.
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const { download } = parseQuery(req, z.object({ download: z.enum(['1']).optional() }));
  const result = await exportReleasedReport(identity, id, { correlationId: ctx.correlationId });
  const disposition = download === '1' ? 'attachment' : 'inline';
  return new Response(result.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, private',
      'content-disposition': `${disposition}; filename="${result.filename}"`,
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-robots-tag': 'noindex, nofollow',
      [correlationIdHeader]: ctx.correlationId,
    },
  });
});

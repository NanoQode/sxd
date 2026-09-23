import { z } from 'zod';
import { uuidSchema } from '@simplexd/contracts';
import { ICS_CONTENT_TYPE } from '@simplexd/integrations/google';
import { params, parseQuery, route } from '@/lib/api/respond';
import { buildAppointmentIcs } from '@/server/appointments/ics';

export const dynamic = 'force-dynamic';

const idSchema = z.object({ id: uuidSchema });
const querySchema = z.object({ token: z.string().min(16).max(128) });

/** GET /api/v1/appointments/:id/ics?token= — calendar file fallback (works while Google sync is pending). */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const { id } = await params(ctx, idSchema);
  const { token } = parseQuery(req, querySchema);
  const ics = await buildAppointmentIcs(id, token);
  return new Response(ics.body, {
    status: 200,
    headers: {
      'content-type': ICS_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${ics.fileName}"`,
      'cache-control': 'no-store',
    },
  });
});

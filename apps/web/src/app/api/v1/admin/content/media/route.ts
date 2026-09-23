import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listApprovedMedia } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/content/media — media assets approved for public use. The
 * picker cannot reach private evidence; uploads arrive in Wave 2.
 */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('content.media.manage');
  return json({ items: await listApprovedMedia(identity), uploads: 'wave_2' }, { correlationId });
});

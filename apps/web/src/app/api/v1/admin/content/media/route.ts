import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listContentMedia } from '@/server/content/media';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/content/media — approved content media with public URLs
 * plus content_media uploads still awaiting scan, derivatives or approval.
 * Uploads go through the shared file pipeline (purpose content_media); the
 * picker never lists private evidence or documents.
 */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('content.media.manage');
  return json(await listContentMedia(identity), { correlationId });
});

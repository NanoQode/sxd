import { contentPreviewRenderSchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';
import { renderPreviewHtml } from '@/server/content/admin';

export const dynamic = 'force-dynamic';

/** POST /api/v1/admin/content/preview-render — server-side sanitised markdown preview. */
export const POST = route(async (req, { correlationId }) => {
  await requireStaff('content.edit');
  const body = await parseJson(req, contentPreviewRenderSchema);
  return json({ html: renderPreviewHtml(body.markdown) }, { correlationId });
});

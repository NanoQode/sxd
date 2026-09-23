import { z } from 'zod';
import { ApiError, fileFinalizeSchema, uuidSchema } from '@simplexd/contracts';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { getIdentity } from '@/lib/auth/session';
import { finalizeUpload } from '@/server/files/finalize';
import '@/lib/api/registry/files';

export const dynamic = 'force-dynamic';

/** POST /api/v1/files/:id/finalize — owner confirms the upload; verification, sniffing and scan hand-off. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const { id } = await params(ctx, z.object({ id: uuidSchema }));
  const body = await parseJson(req, fileFinalizeSchema);
  const result = await finalizeUpload(identity, id, body, { correlationId: ctx.correlationId });
  if (result.outcome === 'rejected') {
    throw new ApiError('file_rejected', result.file.statusReason ?? 'the file was rejected', {
      details: { fileId: id, status: result.file.status },
    });
  }
  return json(result, { status: 202, correlationId: ctx.correlationId });
});

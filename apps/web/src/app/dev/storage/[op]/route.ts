import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { StorageError, type LocalDevStorageProvider } from '@simplexd/integrations/storage';
import { correlationIdFrom } from '@/lib/api/respond';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getDevStorage } from '@/server/files/storage';

/**
 * DEVELOPMENT ONLY. Serves the signed URLs the local-dev storage adapter
 * issues (`/dev/storage/{upload|part|download}?...&sig=`): PUT stores the
 * bytes in the quarantine directory, GET streams an object with the signed
 * content type and disposition plus nosniff/CSP sandbox headers so nothing
 * user-uploaded can execute in the app origin. Refused when APP_ENV is not
 * development or test, or when STORAGE_PROVIDER is not local-dev.
 *
 * The adapter signs URLs under `/api/v1/dev/storage/<op>`; when that path is
 * not served, add a rewrite from it to `/dev/storage/:op` or move this file.
 */

export const dynamic = 'force-dynamic';

function refuse(status: number, message: string, correlationId: string): NextResponse {
  return NextResponse.json(
    { error: { code: status === 404 ? 'not_found' : 'forbidden', message, correlationId } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

type Resolved =
  | { error: NextResponse; provider?: undefined }
  | { provider: LocalDevStorageProvider; error?: undefined };

function devProvider(correlationId: string): Resolved {
  const e = env();
  if (e.APP_ENV !== 'development' && e.APP_ENV !== 'test') {
    return { error: refuse(404, 'not found', correlationId) };
  }
  const provider = getDevStorage();
  if (!provider)
    return { error: refuse(404, 'development storage route is disabled', correlationId) };
  return { provider };
}

export async function PUT(req: Request): Promise<Response> {
  const correlationId = correlationIdFrom(req);
  const resolved = devProvider(correlationId);
  if (resolved.error) return resolved.error;
  const { provider } = resolved;
  const verified = provider.verifySignedRequest(new URL(req.url));
  if (!verified.ok) return refuse(403, `signed URL rejected: ${verified.reason}`, correlationId);
  const { params } = verified;
  if (params.op !== 'upload' && params.op !== 'part')
    return refuse(403, 'signed URL is not an upload URL', correlationId);
  if (params.bucket !== 'quarantine')
    return refuse(403, 'direct uploads may only target quarantine', correlationId);
  const body = req.body ? Readable.fromWeb(req.body as never) : Buffer.alloc(0);
  try {
    if (params.op === 'upload') {
      const result = await provider.writeUploadedObject(params, body);
      return new NextResponse(null, {
        status: 200,
        headers: { etag: result.etag, 'cache-control': 'no-store' },
      });
    }
    const result = await provider.writeUploadedPart(params, body);
    return new NextResponse(null, {
      status: 200,
      headers: { etag: result.etag, 'cache-control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof StorageError) {
      return NextResponse.json(
        { error: { code: 'validation_failed', message: err.message, correlationId } },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    logger().error({ err, correlationId }, 'dev storage upload failed');
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'upload failed', correlationId } },
      { status: 500 },
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  const correlationId = correlationIdFrom(req);
  const resolved = devProvider(correlationId);
  if (resolved.error) return resolved.error;
  const { provider } = resolved;
  const verified = provider.verifySignedRequest(new URL(req.url));
  if (!verified.ok) return refuse(403, `signed URL rejected: ${verified.reason}`, correlationId);
  const { params } = verified;
  if (params.op !== 'download')
    return refuse(403, 'signed URL is not a download URL', correlationId);
  // Quarantined objects are never served, even with a valid signature.
  if (params.bucket === 'quarantine')
    return refuse(403, 'objects in quarantine cannot be downloaded', correlationId);
  try {
    const head = await provider.headObject({ bucket: params.bucket, key: params.key });
    if (!head) return refuse(404, 'object not found', correlationId);
    const stream = await provider.getObjectStream({ bucket: params.bucket, key: params.key });
    const headers = new Headers(provider.downloadHeaders(params));
    headers.set('content-length', String(head.sizeBytes));
    return new NextResponse(Readable.toWeb(stream) as never, { status: 200, headers });
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found')
      return refuse(404, 'object not found', correlationId);
    logger().error({ err, correlationId }, 'dev storage download failed');
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'download failed', correlationId } },
      { status: 500 },
    );
  }
}

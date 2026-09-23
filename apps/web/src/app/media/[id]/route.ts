import { Readable } from 'node:stream';
import { publicMediaQuerySchema, uuidSchema } from '@simplexd/contracts';
import {
  contentDispositionHeader,
  resolveContentDisposition,
  StorageError,
} from '@simplexd/integrations/storage';
import { logger } from '@/lib/logger';
import { resolvePublicMedia } from '@/server/content/media';
import { getStorage } from '@/server/files/storage';

export const dynamic = 'force-dynamic';

/**
 * GET /media/{assetId}[?variant=web|thumb]
 *
 * Streams the approved WebP derivative of a content media asset. Only assets
 * that are content_media, scanned clean, promoted out of quarantine and
 * approved for public use resolve; everything else is 404 and never reveals
 * whether the id exists. Derivatives are images by construction, and the
 * response still pins the type (nosniff, sandboxing CSP) so nothing uploaded
 * can execute in the app origin. Cacheable for a day at the edge and browser;
 * revoking an approval therefore takes effect within that window.
 */

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) return notFound();
  const url = new URL(req.url);
  const query = publicMediaQuerySchema.safeParse({
    variant: url.searchParams.get('variant') ?? undefined,
  });
  if (!query.success) return notFound();

  const media = await resolvePublicMedia(id, query.data.variant);
  if (!media) return notFound();

  const disposition = resolveContentDisposition(media.contentType, 'inline');
  const headers = new Headers({
    'content-type': disposition.contentType,
    'content-disposition': contentDispositionHeader(disposition.disposition, media.fileName),
    'cache-control': CACHE_CONTROL,
    etag: media.etag,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'x-sx-media-alt': encodeURIComponent(media.altText).slice(0, 500),
  });
  if (req.headers.get('if-none-match') === media.etag) {
    return new Response(null, { status: 304, headers });
  }

  const storage = getStorage();
  try {
    const head = await storage.headObject({ bucket: media.bucket, key: media.key });
    if (!head) return notFound();
    headers.set('content-length', String(head.sizeBytes));
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const stream = await storage.getObjectStream({ bucket: media.bucket, key: media.key });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') return notFound();
    logger().error({ err, assetId: id }, 'public media stream failed');
    return new Response('Media temporarily unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '30' },
    });
  }
}

export const HEAD = GET;

import type { ContentDisposition } from './types';

/**
 * Download response policy. Inline rendering is allowed only for image/*,
 * video/* and application/pdf. Markup, XML-based and script types are always
 * served as attachments with an opaque content type so nothing user-uploaded
 * can execute in (or be sniffed into) a document context, even when the
 * declared type was wrong. The app additionally serves signed downloads from
 * a separate origin/bucket host, never from the app origin.
 */

export const NEVER_INLINE_TYPES: readonly string[] = [
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-javascript',
  'application/x-shockwave-flash',
  'text/vbscript',
  'application/x-httpd-php',
  'application/mathml+xml',
  'application/x-sh',
  'application/x-msdownload',
];

export const INLINE_SAFE_PREFIXES: readonly string[] = ['image/', 'video/'];
export const INLINE_SAFE_TYPES: readonly string[] = ['application/pdf'];

export const OPAQUE_CONTENT_TYPE = 'application/octet-stream';

export function normalizeContentType(contentType: string | null | undefined): string {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : OPAQUE_CONTENT_TYPE;
}

/** Types that must never be rendered by a browser as a document. */
export function isActiveContentType(contentType: string): boolean {
  const type = normalizeContentType(contentType);
  if (NEVER_INLINE_TYPES.includes(type)) return true;
  if (type.endsWith('+xml') || type.endsWith('+html')) return true;
  if (type.startsWith('text/') && type !== 'text/plain' && type !== 'text/csv') return true;
  return false;
}

export function isInlineSafe(contentType: string): boolean {
  const type = normalizeContentType(contentType);
  if (isActiveContentType(type)) return false;
  if (INLINE_SAFE_TYPES.includes(type)) return true;
  return INLINE_SAFE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export interface ResolvedDisposition {
  disposition: ContentDisposition;
  contentType: string;
}

export function resolveContentDisposition(
  contentType: string,
  requested: ContentDisposition,
): ResolvedDisposition {
  const type = normalizeContentType(contentType);
  if (isActiveContentType(type)) return { disposition: 'attachment', contentType: OPAQUE_CONTENT_TYPE };
  if (requested === 'inline' && isInlineSafe(type)) return { disposition: 'inline', contentType: type };
  return { disposition: 'attachment', contentType: type };
}

/** ASCII fallback + RFC 5987 UTF-8 name; strips path separators, quotes and control characters. */
export function safeFileName(fileName: string, fallback = 'download'): string {
  const cleaned = fileName
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

export function contentDispositionHeader(disposition: ContentDisposition, fileName: string): string {
  const safe = safeFileName(fileName);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

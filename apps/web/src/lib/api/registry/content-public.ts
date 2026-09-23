import { z } from 'zod';
import {
  listRoutes,
  publicMediaQuerySchema,
  redirectHitSchema,
  redirectImportRequestSchema,
  redirectImportResultSchema,
  redirectSnapshotSchema,
  registerRoute,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for public content delivery (media, redirect
 * resolution) and the redirect CSV import. Idempotent across hot reloads.
 */

function ensure(spec: RouteSpec): RouteSpec {
  return listRoutes().find((r) => r.operationId === spec.operationId) ?? registerRoute(spec);
}

export const contentPublicRoutes = [
  ensure({
    method: 'get',
    path: '/media/{id}',
    summary: 'Approved content media (WebP derivative)',
    description:
      'Streams the web or thumb derivative of a media asset that is content_media, scanned clean, promoted out of quarantine and approved for public use. Anything else answers 404. Served with nosniff, a sandboxing CSP and a one-day public cache; originals, documents, video and private purposes are never served here.',
    tags: ['Public: content'],
    operationId: 'publicMedia',
    auth: 'public',
    request: { params: z.object({ id: uuidSchema }), query: publicMediaQuerySchema },
    responses: {
      200: { description: 'image/webp bytes' },
      304: { description: 'Not modified (ETag)' },
      404: { description: 'Not approved, not clean, not content media, or unknown' },
    },
  }),
  ensure({
    method: 'get',
    path: '/api/v1/redirects/snapshot',
    summary: 'Active redirects for the proxy table',
    tags: ['Public: content'],
    operationId: 'publicRedirectSnapshot',
    auth: 'public',
    responses: { 200: { description: 'Snapshot', body: redirectSnapshotSchema } },
  }),
  ensure({
    method: 'post',
    path: '/api/v1/redirects/hits',
    summary: 'Count a served redirect (proxy callback)',
    tags: ['Public: content'],
    operationId: 'publicRedirectHit',
    auth: 'public',
    request: { body: redirectHitSchema },
    responses: {
      200: { description: 'Whether an active redirect was counted', body: z.object({ counted: z.boolean() }) },
      429: { description: 'Rate limited' },
    },
  }),
  ensure({
    method: 'post',
    path: '/api/v1/admin/redirects/import',
    summary: 'Bulk import redirects from CSV (dry run by default)',
    description:
      'Columns path,target,status (aliases from_path/source_url, to_path/target_url, status_code). Rows with a decision column are imported only when it is "redirect". Each row is validated like a single redirect (reserved prefixes, live pages, loops, chains, duplicates); invalid rows are reported and skipped.',
    tags: ['Admin: content'],
    operationId: 'adminImportRedirects',
    auth: 'staff',
    request: { body: redirectImportRequestSchema },
    responses: { 200: { description: 'Per-row outcomes', body: redirectImportResultSchema } },
  }),
];

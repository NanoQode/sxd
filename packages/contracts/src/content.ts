import { z } from 'zod';
import { isoDateTimeSchema, slugSchema, uuidSchema } from './common';
import { fileStatusSchema } from './files';

/** CMS: pages, services copy, FAQs, resources, policies, navigation, banners. */

export const contentKindSchema = z.enum([
  'page',
  'service',
  'location_intro',
  'resource',
  'faq',
  'policy',
  'case_study',
  'testimonial',
  'banner',
  'navigation',
  'contact',
  'goal_path',
  'evidence_standard',
]);

export const contentStatusSchema = z.enum([
  'draft',
  'in_review',
  'scheduled',
  'published',
  'unpublished',
  'archived',
]);

export const seoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(160).optional(),
  canonical: z.string().url().optional(),
  noindex: z.boolean().optional(),
  ogImageFileId: uuidSchema.optional(),
});

export const contentRevisionInputSchema = z.object({
  title: z.string().min(1).max(160),
  bodyMarkdown: z.string().max(200_000),
  fields: z.record(z.string(), z.unknown()).optional(),
  summary: z.string().max(500).optional(),
});

export const contentPageCreateSchema = contentRevisionInputSchema.extend({
  slug: slugSchema,
  kind: contentKindSchema,
  locale: z.string().min(2).max(8).default('en'),
  seo: seoSchema.optional(),
  sortOrder: z.number().int().default(0),
  relatedEntityType: z.string().max(40).optional(),
  relatedEntityId: uuidSchema.optional(),
});

export const contentPagePatchSchema = z.object({
  seo: seoSchema.optional(),
  sortOrder: z.number().int().optional(),
  expectedVersion: z.number().int().min(1),
});

export const contentPublishActionSchema = z.object({
  action: z.enum([
    'submit_for_review',
    'approve',
    'publish',
    'schedule',
    'unpublish',
    'archive',
    'rollback',
  ]),
  revision: z.number().int().min(1).optional(),
  publishAt: isoDateTimeSchema.optional(),
  note: z.string().max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});

export const contentPageDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  kind: contentKindSchema,
  title: z.string(),
  status: contentStatusSchema,
  locale: z.string(),
  currentRevision: z.number().int(),
  publishedRevision: z.number().int().nullable(),
  publishAt: isoDateTimeSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  seo: seoSchema.nullable(),
  sortOrder: z.number().int(),
  version: z.number().int(),
  updatedAt: isoDateTimeSchema,
});
export type ContentPageDto = z.infer<typeof contentPageDtoSchema>;

export const contentRevisionDtoSchema = z.object({
  id: uuidSchema,
  pageId: uuidSchema,
  revision: z.number().int(),
  title: z.string(),
  bodyMarkdown: z.string(),
  bodyHtmlSanitized: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).nullable(),
  summary: z.string().nullable(),
  reviewStatus: z.string(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type ContentRevisionDto = z.infer<typeof contentRevisionDtoSchema>;

/** Published content shape used by public pages. */
export const publishedContentSchema = z.object({
  slug: z.string(),
  kind: contentKindSchema,
  title: z.string(),
  bodyHtml: z.string(),
  bodyMarkdown: z.string(),
  fields: z.record(z.string(), z.unknown()),
  seo: seoSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
});
export type PublishedContent = z.infer<typeof publishedContentSchema>;

export const redirectUpsertSchema = z.object({
  fromPath: z.string().regex(/^\/[^\s]*$/, 'must start with /'),
  toPath: z.string().regex(/^\/[^\s]*$|^https:\/\/[^\s]+$/, 'relative path or https URL'),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(308)]).default(301),
  active: z.boolean().default(true),
  note: z.string().max(200).optional(),
});

/* ---------------------------------------------------------------------- */
/* Redirect resolution and bulk import                                     */
/* ---------------------------------------------------------------------- */

/** Active redirects as the proxy caches them in memory (paths only, no ids or notes). */
export const redirectSnapshotSchema = z.object({
  /** Changes whenever a redirect is created or edited; the proxy uses it for logging only. */
  version: z.string(),
  items: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      status: z.number().int(),
    }),
  ),
});
export type RedirectSnapshot = z.infer<typeof redirectSnapshotSchema>;

export const redirectHitSchema = z.object({ path: z.string().min(1).max(2048) });

/**
 * Bulk CSV import. Columns `path,target,status` (aliases: from_path/source_url,
 * to_path/target_url, status_code). Rows with a `decision` column are imported
 * only when the decision is `redirect`, so the site inventory can be fed in
 * directly. `dryRun` (default) validates and previews without writing.
 */
export const redirectImportRequestSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
});
export type RedirectImportRequest = z.infer<typeof redirectImportRequestSchema>;

export const redirectImportOutcomeSchema = z.enum([
  /** Valid; would be created (dry run) or was created. */
  'create',
  'created',
  /** Identical redirect already exists. */
  'unchanged',
  /** Skipped on purpose (for example an inventory row whose decision is not redirect). */
  'skip',
  'error',
]);
export type RedirectImportOutcome = z.infer<typeof redirectImportOutcomeSchema>;

export const redirectImportRowSchema = z.object({
  line: z.number().int(),
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
  outcome: redirectImportOutcomeSchema,
  reason: z.string().nullable(),
});
export type RedirectImportRow = z.infer<typeof redirectImportRowSchema>;

export const redirectImportResultSchema = z.object({
  dryRun: z.boolean(),
  rows: z.array(redirectImportRowSchema),
  summary: z.object({
    total: z.number().int(),
    create: z.number().int(),
    created: z.number().int(),
    unchanged: z.number().int(),
    skip: z.number().int(),
    error: z.number().int(),
  }),
});
export type RedirectImportResult = z.infer<typeof redirectImportResultSchema>;

/* ---------------------------------------------------------------------- */
/* Site-wide structures the public site renders from published pages      */
/* ---------------------------------------------------------------------- */

/** A link an editor may configure: an app path or an https URL, never a script. */
export const siteHrefSchema = z
  .string()
  .trim()
  .regex(/^\/(?!\/)[^\s]*$|^https:\/\/[^\s]+$/, 'relative path or https URL');

export const siteLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  href: siteHrefSchema,
});
export type SiteLink = z.infer<typeof siteLinkSchema>;

/**
 * Navigation slots. A published `navigation` page fills the slot named by
 * `fields.slot`, or by its slug (`header`, `navigation-header`, …). Slots
 * without a published page keep the built-in defaults.
 */
export const NAVIGATION_SLOTS = [
  'header',
  'header-secondary',
  'footer-explore',
  'footer-company',
] as const;
export const navigationSlotSchema = z.enum(NAVIGATION_SLOTS);
export type NavigationSlot = z.infer<typeof navigationSlotSchema>;

export const navigationFieldsSchema = z.object({
  slot: navigationSlotSchema.optional(),
  items: z.array(siteLinkSchema).min(1).max(12),
});
export type NavigationFields = z.infer<typeof navigationFieldsSchema>;

export const bannerToneSchema = z.enum(['info', 'warning', 'success']);
export type BannerTone = z.infer<typeof bannerToneSchema>;

/**
 * Site-wide announcement banner. The message is plain text (the page body,
 * already sanitised, is used when `message` is empty). `startsAt`/`endsAt`
 * narrow the display window inside the publication window.
 */
export const bannerFieldsSchema = z.object({
  message: z.string().trim().max(300).optional().nullable(),
  href: siteHrefSchema.optional().nullable(),
  linkLabel: z.string().trim().max(60).optional().nullable(),
  tone: bannerToneSchema.default('info'),
  startsAt: isoDateTimeSchema.optional().nullable(),
  endsAt: isoDateTimeSchema.optional().nullable(),
  dismissible: z.boolean().default(true),
});
export type BannerFields = z.infer<typeof bannerFieldsSchema>;

export const GOAL_PATH_KEYS = [
  'buy_safely',
  'build_with_oversight',
  'manage_property',
  'invest_and_compare',
] as const;
export const goalPathKeySchema = z.enum(GOAL_PATH_KEYS);
export type GoalPathKey = z.infer<typeof goalPathKeySchema>;

/** Homepage goal card. Unset fields keep the built-in default for that key. */
export const goalPathFieldsSchema = z.object({
  key: goalPathKeySchema,
  description: z.string().trim().max(400).optional().nullable(),
  href: siteHrefSchema.optional().nullable(),
  exploreHref: siteHrefSchema.optional().nullable(),
  serviceSlugs: z.array(slugSchema).max(6).optional().nullable(),
});
export type GoalPathFields = z.infer<typeof goalPathFieldsSchema>;

/**
 * Location introduction: shown on /locations/{marketSlug}. Matched by slug
 * `location-intro-{marketSlug}` or by `fields.marketSlug`.
 */
export const locationIntroFieldsSchema = z.object({
  marketSlug: slugSchema.optional().nullable(),
});
export type LocationIntroFields = z.infer<typeof locationIntroFieldsSchema>;

export function locationIntroSlug(marketSlug: string): string {
  return `location-intro-${marketSlug}`;
}

/* ---------------------------------------------------------------------- */
/* Public content media                                                     */
/* ---------------------------------------------------------------------- */

export const publicMediaVariantSchema = z.enum(['web', 'thumb']);
export type PublicMediaVariant = z.infer<typeof publicMediaVariantSchema>;

export const publicMediaQuerySchema = z.object({
  variant: publicMediaVariantSchema.default('web'),
});

/** Public URL of an approved media asset (derivatives only; originals are never public). */
export function publicMediaPath(assetId: string, variant: PublicMediaVariant = 'web'): string {
  return variant === 'web' ? `/media/${assetId}` : `/media/${assetId}?variant=${variant}`;
}

/** Approved asset as listed by the content media picker. */
export const contentMediaAssetDtoSchema = z.object({
  id: uuidSchema,
  fileId: uuidSchema,
  altText: z.string(),
  caption: z.string().nullable(),
  originalName: z.string(),
  declaredMime: z.string(),
  approvedForPublic: z.boolean(),
  rightsConfirmed: z.boolean(),
  uploadedBy: z.string().nullable(),
  publicUrl: z.string(),
  thumbUrl: z.string(),
  createdAt: isoDateTimeSchema,
});
export type ContentMediaAssetDto = z.infer<typeof contentMediaAssetDtoSchema>;

/** A content_media upload that is not (yet) approved for public use. */
export const contentMediaPendingDtoSchema = z.object({
  fileId: uuidSchema,
  originalName: z.string(),
  declaredMime: z.string(),
  status: fileStatusSchema,
  statusReason: z.string().nullable(),
  hasWebVariant: z.boolean(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type ContentMediaPendingDto = z.infer<typeof contentMediaPendingDtoSchema>;

export const contentMediaListResponseSchema = z.object({
  items: z.array(contentMediaAssetDtoSchema),
  pending: z.array(contentMediaPendingDtoSchema),
});
export type ContentMediaListResponse = z.infer<typeof contentMediaListResponseSchema>;

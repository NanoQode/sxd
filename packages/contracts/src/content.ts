import { z } from 'zod';
import { isoDateTimeSchema, slugSchema, uuidSchema } from './common';

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

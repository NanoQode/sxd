import { z } from 'zod';
import { cursorPaginationQuerySchema, isoDateTimeSchema, uuidSchema } from './common';

/**
 * Private file pipeline contracts: upload intents, finalisation, downloads,
 * grants and public approval. Storage keys and bucket names never appear on
 * the wire; clients only ever see file ids and short-lived signed URLs.
 */

export const FILE_PURPOSES = [
  /** Documents an organisation keeps on its account (contracts, letters, surveys). */
  'org_document',
  /** Site-visit photos, video, drone footage and inspection documents. */
  'evidence',
  /** CMS media (images/video) managed by content staff; public only after approval. */
  'content_media',
  /** Proof of bank transfer for an invoice. */
  'bank_receipt',
  /** Identity documents (sensitive: owner and files.sensitive.read only). */
  'identity',
  /**
   * A partner's own submission documents (bid attachments, RFQ quotations).
   * Owned by the partner, not by a customer organisation; referenced from the
   * bid or response, and readable by staff once the submission may be opened.
   */
  'partner_submission',
] as const;
export const filePurposeSchema = z.enum(FILE_PURPOSES);
export type FilePurpose = z.infer<typeof filePurposeSchema>;

export const SENSITIVE_FILE_PURPOSES: readonly FilePurpose[] = ['identity'];

export const FILE_STATUSES = [
  'pending_upload',
  'uploaded',
  'scanning',
  'clean',
  'infected',
  'scan_failed',
  'rejected',
  'deleted',
] as const;
export const fileStatusSchema = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof fileStatusSchema>;

export const FILE_ENTITY_TYPES = [
  'project',
  'site_visit',
  'service_request',
  'invoice',
  'property',
  'content_page',
] as const;
export const fileEntityTypeSchema = z.enum(FILE_ENTITY_TYPES);
export type FileEntityType = z.infer<typeof fileEntityTypeSchema>;

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
const VIDEO_MIME = ['video/mp4', 'video/quicktime'] as const;
const DOCUMENT_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
] as const;

const MB = 1024 * 1024;

export interface FilePurposePolicy {
  allowedMime: readonly string[];
  /** Per-file limit; video evidence is the only purpose allowed past 100 MB. */
  maxBytes: number;
  /** Per-type limit applied before the purpose limit. */
  maxBytesByFamily: { image: number; video: number; document: number };
  /** Whether the purpose needs an entity to attach to. */
  requiresEntity: boolean;
  sensitive: boolean;
}

/**
 * Allow-lists per purpose. SVG, HTML, XML and scripts are never in any list
 * (the storage layer additionally sniffs bytes after upload). Sizes are
 * deliberate ceilings, not targets: the UI compresses images before upload.
 */
export const FILE_PURPOSE_POLICIES: Record<FilePurpose, FilePurposePolicy> = {
  org_document: {
    allowedMime: [...IMAGE_MIME, ...DOCUMENT_MIME, 'application/zip'],
    maxBytes: 100 * MB,
    maxBytesByFamily: { image: 25 * MB, video: 0, document: 100 * MB },
    requiresEntity: false,
    sensitive: false,
  },
  evidence: {
    allowedMime: [...IMAGE_MIME, ...VIDEO_MIME, ...DOCUMENT_MIME],
    maxBytes: 2048 * MB,
    maxBytesByFamily: { image: 50 * MB, video: 2048 * MB, document: 100 * MB },
    requiresEntity: true,
    sensitive: false,
  },
  content_media: {
    allowedMime: [...IMAGE_MIME, ...VIDEO_MIME, 'application/pdf'],
    maxBytes: 512 * MB,
    maxBytesByFamily: { image: 25 * MB, video: 512 * MB, document: 50 * MB },
    requiresEntity: false,
    sensitive: false,
  },
  bank_receipt: {
    allowedMime: [...IMAGE_MIME, 'application/pdf'],
    maxBytes: 25 * MB,
    maxBytesByFamily: { image: 25 * MB, video: 0, document: 25 * MB },
    requiresEntity: false,
    sensitive: false,
  },
  identity: {
    allowedMime: [...IMAGE_MIME, 'application/pdf'],
    maxBytes: 25 * MB,
    maxBytesByFamily: { image: 25 * MB, video: 0, document: 25 * MB },
    requiresEntity: false,
    sensitive: true,
  },
  partner_submission: {
    allowedMime: [...IMAGE_MIME, ...DOCUMENT_MIME, 'application/zip'],
    maxBytes: 100 * MB,
    maxBytesByFamily: { image: 25 * MB, video: 0, document: 100 * MB },
    requiresEntity: false,
    sensitive: false,
  },
};

/** Uploads above this size are planned as resumable multipart uploads. */
export const MULTIPART_THRESHOLD_BYTES = 64 * MB;

export const UPLOAD_INTENT_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_DEFAULT_SECONDS = 5 * 60;
export const DOWNLOAD_URL_MAX_SECONDS = 15 * 60;

const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\u0000-\u001f\\/]/.test(v), 'file name must not contain path separators');

const mimeSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'media type');

export const uploadIntentCreateSchema = z
  .object({
    purpose: filePurposeSchema,
    fileName: fileNameSchema,
    declaredMime: mimeSchema,
    sizeBytes: z.number().int().positive(),
    /** Client-computed SHA-256 (hex or base64); verified after upload when supplied. */
    sha256: z.string().min(43).max(80).optional(),
    entityType: fileEntityTypeSchema.optional(),
    entityId: uuidSchema.optional(),
    /** Force a resumable multipart upload regardless of size. */
    multipart: z.boolean().optional(),
  })
  .refine((v) => (v.entityType === undefined) === (v.entityId === undefined), {
    message: 'entityType and entityId must be supplied together',
    path: ['entityId'],
  });
export type UploadIntentCreate = z.infer<typeof uploadIntentCreateSchema>;

const uploadPartSchema = z.object({ partNumber: z.number().int().min(1), url: z.string() });

export const uploadIntentResponseSchema = z.object({
  fileId: uuidSchema,
  status: fileStatusSchema,
  expiresAt: isoDateTimeSchema,
  upload: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('single'),
      method: z.literal('PUT'),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
    }),
    z.object({
      kind: z.literal('multipart'),
      method: z.literal('PUT'),
      uploadId: z.string(),
      partSizeBytes: z.number().int().positive(),
      parts: z.array(uploadPartSchema),
    }),
  ]),
});
export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;

export const fileFinalizeSchema = z.object({
  /** SHA-256 declared at finalisation (overrides the intent's value). */
  sha256: z.string().min(43).max(80).optional(),
  /** Multipart uploads: the ETag of every uploaded part. */
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10_000)
    .optional(),
});
export type FileFinalize = z.infer<typeof fileFinalizeSchema>;

export const fileDtoSchema = z.object({
  id: uuidSchema,
  organizationId: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  purpose: filePurposeSchema.or(z.string()),
  status: fileStatusSchema,
  originalName: z.string(),
  declaredMime: z.string(),
  detectedMime: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  checksumSha256: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  uploadKind: z.enum(['single', 'multipart']),
  sensitive: z.boolean(),
  isPublicApproved: z.boolean(),
  /** Available derivative variants (keys are never exposed). */
  variants: z.array(z.enum(['thumb', 'web'])),
  /** Human-readable reason when rejected, infected or scan_failed. */
  statusReason: z.string().nullable(),
  scannedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type FileDto = z.infer<typeof fileDtoSchema>;

export const fileFinalizeResponseSchema = z.object({
  file: fileDtoSchema,
  /** `scanning` when queued, `rejected` when the bytes failed inspection. */
  outcome: z.enum(['scanning', 'rejected']),
});
export type FileFinalizeResponse = z.infer<typeof fileFinalizeResponseSchema>;

export const fileListQuerySchema = cursorPaginationQuerySchema.extend({
  entityType: fileEntityTypeSchema,
  entityId: uuidSchema,
  status: fileStatusSchema.optional(),
});
export type FileListQuery = z.infer<typeof fileListQuerySchema>;

export const fileVariantSchema = z.enum(['thumb', 'web']);
export type FileVariant = z.infer<typeof fileVariantSchema>;

export const fileDownloadQuerySchema = z.object({
  variant: fileVariantSchema.optional(),
  /** Seconds the signed URL stays valid (default 300, max 900). */
  expiresIn: z.coerce.number().int().min(30).max(DOWNLOAD_URL_MAX_SECONDS).optional(),
  /** `inline` is honoured only for images, video and PDF. */
  disposition: z.enum(['inline', 'attachment']).optional(),
});
export type FileDownloadQuery = z.infer<typeof fileDownloadQuerySchema>;

export const fileDownloadResponseSchema = z.object({
  url: z.string(),
  expiresAt: isoDateTimeSchema,
  contentType: z.string(),
  contentDisposition: z.enum(['inline', 'attachment']),
});
export type FileDownloadResponse = z.infer<typeof fileDownloadResponseSchema>;

export const fileGrantLevelSchema = z.enum(['view', 'download']);
export type FileGrantLevel = z.infer<typeof fileGrantLevelSchema>;

export const fileGrantCreateSchema = z
  .object({
    userId: z.string().min(1).max(128).optional(),
    organizationId: z.string().min(1).max(128).optional(),
    level: fileGrantLevelSchema.default('view'),
    expiresAt: isoDateTimeSchema.optional(),
  })
  .refine((v) => (v.userId === undefined) !== (v.organizationId === undefined), {
    message: 'exactly one of userId or organizationId is required',
    path: ['userId'],
  });
export type FileGrantCreate = z.infer<typeof fileGrantCreateSchema>;

export const fileGrantDtoSchema = z.object({
  id: uuidSchema,
  fileId: uuidSchema,
  userId: z.string().nullable(),
  organizationId: z.string().nullable(),
  level: fileGrantLevelSchema,
  grantedBy: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type FileGrantDto = z.infer<typeof fileGrantDtoSchema>;

export const filePublicApprovalSchema = z
  .object({
    approved: z.boolean(),
    altText: z.string().min(1).max(500).optional(),
    caption: z.string().max(1000).optional(),
    rightsConfirmed: z.boolean().optional(),
    rightsNote: z.string().max(1000).optional(),
  })
  .refine((v) => !v.approved || (Boolean(v.altText) && v.rightsConfirmed === true), {
    message: 'approving for public use requires altText and rightsConfirmed=true',
    path: ['approved'],
  });
export type FilePublicApproval = z.infer<typeof filePublicApprovalSchema>;

export const filePublicApprovalResponseSchema = z.object({
  file: fileDtoSchema,
  mediaAsset: z
    .object({
      id: uuidSchema,
      altText: z.string(),
      caption: z.string().nullable(),
      rightsConfirmed: z.boolean(),
      approvedForPublic: z.boolean(),
    })
    .nullable(),
});
export type FilePublicApprovalResponse = z.infer<typeof filePublicApprovalResponseSchema>;

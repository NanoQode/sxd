import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, jsonObject, timestamps, tstz, version } from './_common';
import { organization, user } from './auth';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const fileBucketEnum = pgEnum('file_bucket', ['private', 'quarantine', 'derivatives']);

export const fileStatusEnum = pgEnum('file_status', [
  'pending_upload',
  'uploaded',
  'scanning',
  'clean',
  'infected',
  'scan_failed',
  'rejected',
  'deleted',
]);

export const uploadKindEnum = pgEnum('upload_kind', ['single', 'multipart']);

export const fileGrantLevelEnum = pgEnum('file_grant_level', ['view', 'download']);

export const integrationProviderEnum = pgEnum('integration_provider', [
  'paystack',
  'termii',
  'smtp',
  'google_workspace',
  'storage',
  'maps',
  'geocoding',
  'scanner',
  'analytics',
]);

export const integrationEnvironmentEnum = pgEnum('integration_environment', ['test', 'live']);

export const integrationStatusEnum = pgEnum('integration_status', [
  'disconnected',
  'configured_unverified',
  'connected',
  'degraded',
  'expired',
  'disabled',
]);

export const actorTypeEnum = pgEnum('actor_type', [
  'user',
  'system',
  'job',
  'webhook',
  'anonymous',
]);

export const contentKindEnum = pgEnum('content_kind', [
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

export const contentStatusEnum = pgEnum('content_status', [
  'draft',
  'in_review',
  'scheduled',
  'published',
  'unpublished',
  'archived',
]);

export const featureFlagCategoryEnum = pgEnum('feature_flag_category', [
  'core',
  'expansion',
  'regulated_gated',
  'experimental',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
]);

export const fileObjects = pgTable(
  'file_objects',
  {
    id: id(),
    organizationId: text().references(() => organization.id),
    ownerUserId: text().references(() => user.id),
    bucket: fileBucketEnum().notNull().default('quarantine'),
    storageKey: text().notNull().unique(),
    originalName: text().notNull(),
    declaredMime: text().notNull(),
    detectedMime: text(),
    sizeBytes: bigint({ mode: 'number' }),
    checksumSha256: text(),
    status: fileStatusEnum().notNull().default('pending_upload'),
    scanResult: jsonb(),
    scannedAt: tstz(),
    uploadKind: uploadKindEnum().notNull().default('single'),
    multipartUploadId: text(),
    derivatives: jsonObject<Record<string, string>>(),
    purpose: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    isPublicApproved: boolean().notNull().default(false),
    retentionUntil: tstz(),
    deletedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('file_objects_org_idx').on(t.organizationId),
    index('file_objects_entity_idx').on(t.entityType, t.entityId),
    index('file_objects_status_idx').on(t.status),
  ],
);

export const fileAccessGrants = pgTable(
  'file_access_grants',
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => fileObjects.id),
    userId: text().references(() => user.id),
    organizationId: text().references(() => organization.id),
    level: fileGrantLevelEnum().notNull().default('view'),
    grantedBy: text().references(() => user.id),
    expiresAt: tstz(),
    revokedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    index('file_access_grants_file_idx').on(t.fileId),
    index('file_access_grants_user_idx').on(t.userId),
  ],
);

export const fileDownloadLog = pgTable(
  'file_download_log',
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => fileObjects.id),
    userId: text().references(() => user.id),
    ipHash: text(),
    purpose: text(),
    createdAt: createdAt(),
  },
  (t) => [index('file_download_log_file_idx').on(t.fileId)],
);

/** Envelope-encrypted secrets: a per-secret data key wrapped by the master key. */
export const secretReferences = pgTable(
  'secret_references',
  {
    id: id(),
    provider: text().notNull(),
    environment: text().notNull(),
    fieldName: text().notNull(),
    masterKeyId: text().notNull(),
    wrappedDek: bytea().notNull(),
    dekIv: bytea().notNull(),
    dekTag: bytea().notNull(),
    ciphertext: bytea().notNull(),
    iv: bytea().notNull(),
    tag: bytea().notNull(),
    version: integer().notNull().default(1),
    fingerprint: text().notNull(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
    rotatedAt: tstz(),
    retiredAt: tstz(),
    lastUsedAt: tstz(),
  },
  (t) => [index('secret_references_lookup_idx').on(t.provider, t.environment, t.fieldName)],
);

export const integrationConfigs = pgTable(
  'integration_configs',
  {
    id: id(),
    provider: integrationProviderEnum().notNull(),
    environment: integrationEnvironmentEnum().notNull().default('test'),
    version: integer().notNull().default(1),
    isActive: boolean().notNull().default(false),
    status: integrationStatusEnum().notNull().default('disconnected'),
    enabled: boolean().notNull().default(false),
    settings: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    secretIds: jsonObject<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    adapter: text().notNull().default('dev'),
    lastCheckAt: tstz(),
    lastCheckOk: boolean(),
    lastCheckMessage: text(),
    lastSuccessAt: tstz(),
    credentialRotatedAt: tstz(),
    activatedAt: tstz(),
    activatedBy: text().references(() => user.id),
    updatedBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('integration_configs_unique').on(t.provider, t.environment, t.version),
    uniqueIndex('integration_configs_active_unique')
      .on(t.provider, t.environment)
      .where(sql`${t.isActive}`),
  ],
);

export const integrationLogs = pgTable(
  'integration_logs',
  {
    id: id(),
    provider: text().notNull(),
    environment: text().notNull(),
    level: text().notNull().default('info'),
    event: text().notNull(),
    messageSanitized: text(),
    metadataSanitized: jsonb(),
    correlationId: text(),
    createdAt: createdAt(),
  },
  (t) => [index('integration_logs_provider_idx').on(t.provider, t.createdAt)],
);

/** Append-only audit trail; updates and deletes are blocked by trigger. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    actorType: actorTypeEnum().notNull().default('user'),
    actorUserId: text(),
    impersonationId: uuid(),
    organizationId: text(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    before: jsonb(),
    after: jsonb(),
    reason: text(),
    ipHash: text(),
    userAgent: text(),
    correlationId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
    index('audit_events_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_events_org_idx').on(t.organizationId, t.createdAt),
  ],
);

export const contentPages = pgTable(
  'content_pages',
  {
    id: id(),
    slug: text().notNull().unique(),
    kind: contentKindEnum().notNull().default('page'),
    title: text().notNull(),
    status: contentStatusEnum().notNull().default('draft'),
    locale: text().notNull().default('en'),
    currentRevision: integer().notNull().default(0),
    publishedRevision: integer(),
    publishAt: tstz(),
    publishedAt: tstz(),
    unpublishedAt: tstz(),
    seo: jsonObject<{
      title?: string;
      description?: string;
      canonical?: string;
      noindex?: boolean;
      ogImageFileId?: string;
    }>(),
    sortOrder: integer().notNull().default(0),
    relatedEntityType: text(),
    relatedEntityId: uuid(),
    createdBy: text().references(() => user.id),
    updatedBy: text().references(() => user.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [index('content_pages_kind_idx').on(t.kind, t.status)],
);

export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: id(),
    pageId: uuid()
      .notNull()
      .references(() => contentPages.id),
    revision: integer().notNull(),
    title: text().notNull(),
    bodyMarkdown: text().notNull(),
    bodyHtmlSanitized: text(),
    fields: jsonb(),
    summary: text(),
    reviewStatus: text().notNull().default('draft'),
    reviewedBy: text().references(() => user.id),
    reviewedAt: tstz(),
    createdBy: text().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('content_revisions_unique').on(t.pageId, t.revision)],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    fileId: uuid()
      .notNull()
      .references(() => fileObjects.id),
    altText: text().notNull(),
    caption: text(),
    rightsNote: text(),
    rightsConfirmed: boolean().notNull().default(false),
    approvedForPublic: boolean().notNull().default(false),
    approvedBy: text().references(() => user.id),
    uploadedBy: text().references(() => user.id),
    ...timestamps(),
  },
  (t) => [index('media_assets_file_idx').on(t.fileId)],
);

export const redirects = pgTable('redirects', {
  id: id(),
  fromPath: text().notNull().unique(),
  toPath: text().notNull(),
  statusCode: integer().notNull().default(301),
  active: boolean().notNull().default(true),
  note: text(),
  hitCount: integer().notNull().default(0),
  createdBy: text().references(() => user.id),
  ...timestamps(),
});

export const featureFlags = pgTable('feature_flags', {
  id: id(),
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  category: featureFlagCategoryEnum().notNull().default('expansion'),
  enabled: boolean().notNull().default(false),
  rollout: jsonObject<{ organizationIds?: string[]; staffOnly?: boolean }>(),
  requiresReview: boolean().notNull().default(false),
  reviewNote: text(),
  updatedBy: text().references(() => user.id),
  ...timestamps(),
});

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  description: text(),
  updatedBy: text().references(() => user.id),
  ...timestamps(),
});

/** Transactional outbox: written in the same transaction as the business change. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    eventType: text().notNull(),
    aggregateType: text().notNull(),
    aggregateId: text().notNull(),
    organizationId: text(),
    actorUserId: text(),
    payload: jsonb().notNull(),
    correlationId: text(),
    createdAt: createdAt(),
    publishedAt: tstz(),
    attempts: integer().notNull().default(0),
    lastError: text(),
  },
  (t) => [
    index('outbox_events_unpublished_idx')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

/** Durable job queue consumed by the worker with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    queue: text().notNull().default('default'),
    type: text().notNull(),
    payload: jsonb().notNull(),
    organizationId: text(),
    actorUserId: text(),
    status: jobStatusEnum().notNull().default('pending'),
    priority: integer().notNull().default(0),
    runAt: tstz().notNull().defaultNow(),
    lockedAt: tstz(),
    lockedBy: text(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    lastError: text(),
    dedupeKey: text().unique(),
    correlationId: text(),
    completedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index('jobs_ready_idx')
      .on(t.queue, t.priority, t.runAt)
      .where(sql`${t.status} = 'pending'`),
    index('jobs_status_idx').on(t.status, t.updatedAt),
  ],
);

export const jobFailures = pgTable(
  'job_failures',
  {
    id: id(),
    jobId: uuid()
      .notNull()
      .references(() => jobs.id),
    attempt: integer().notNull(),
    errorMessageSanitized: text().notNull(),
    stackSanitized: text(),
    failedAt: createdAt(),
  },
  (t) => [index('job_failures_job_idx').on(t.jobId)],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: id(),
    sessionHash: text(),
    eventName: text().notNull(),
    path: text(),
    props: jsonb(),
    consentVersion: text(),
    createdAt: createdAt(),
  },
  (t) => [index('analytics_events_name_idx').on(t.eventName, t.createdAt)],
);

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text().primaryKey(),
  count: integer().notNull().default(0),
  windowStart: tstz().notNull().defaultNow(),
});

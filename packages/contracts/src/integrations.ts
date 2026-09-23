import { z } from 'zod';
import { uuidSchema } from './common';

/**
 * Admin → Integrations contracts (brief §12–§16).
 *
 * Save, test and activate are distinct operations and the API never returns
 * a secret: only presence, fingerprint and last-change metadata. Provider
 * settings schemas live with the adapters (`@simplexd/integrations`); this
 * module carries the generic envelope shared by the API, the OpenAPI
 * registry and the admin console.
 */

export const INTEGRATION_PROVIDERS = [
  'paystack',
  'termii',
  'smtp',
  'google_workspace',
  'storage',
  'scanner',
  'maps',
] as const;
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

export const integrationEnvironmentSchema = z.enum(['test', 'live']);
export type IntegrationEnvironment = z.infer<typeof integrationEnvironmentSchema>;

export const INTEGRATION_STATUSES = [
  'disconnected',
  'configured_unverified',
  'connected',
  'degraded',
  'expired',
  'disabled',
] as const;
export const integrationStatusSchema = z.enum(INTEGRATION_STATUSES);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const integrationFieldKindSchema = z.enum([
  'string',
  'integer',
  'boolean',
  'enum',
  'string_list',
  'email',
  'url',
]);

/** Serialisable description of one admin form field (never carries values). */
export const integrationFieldDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: integrationFieldKindSchema,
  help: z.string().default(''),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  placeholder: z.string().optional(),
});
export type IntegrationFieldDescriptor = z.infer<typeof integrationFieldDescriptorSchema>;

export const integrationSecretDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().default(''),
  required: z.boolean().default(false),
});
export type IntegrationSecretDescriptor = z.infer<typeof integrationSecretDescriptorSchema>;

export const integrationProviderDescriptorSchema = z.object({
  provider: integrationProviderSchema,
  name: z.string(),
  summary: z.string(),
  /** Adapters selectable for this provider; `devAdapter` is the labelled development one. */
  adapters: z.array(z.object({ id: z.string(), label: z.string(), development: z.boolean() })),
  devAdapter: z.string().nullable(),
  fields: z.array(integrationFieldDescriptorSchema),
  secrets: z.array(integrationSecretDescriptorSchema),
  /** Extra permission needed to write secrets (Paystack: payment credentials). */
  secretsPermission: z.string().nullable(),
  docsPath: z.string(),
  links: z.array(z.object({ label: z.string(), href: z.string(), external: z.boolean() })),
  /** Read-only facts the operator needs while configuring (webhook URL, redirect URI). */
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type IntegrationProviderDescriptor = z.infer<typeof integrationProviderDescriptorSchema>;

/** Masked presence of a secret field. Never the value, ciphertext or wrapped key. */
export const integrationSecretPresenceSchema = z.object({
  set: z.boolean(),
  /** First 8 hex characters of the SHA-256 fingerprint; enough to see that a value changed. */
  fingerprint: z.string().nullable(),
  masked: z.string(),
  updatedAt: z.string().nullable(),
  masterKeyId: z.string().nullable(),
});
export type IntegrationSecretPresence = z.infer<typeof integrationSecretPresenceSchema>;

export const integrationConfigDtoSchema = z.object({
  id: uuidSchema,
  provider: integrationProviderSchema,
  environment: integrationEnvironmentSchema,
  version: z.number().int(),
  isActive: z.boolean(),
  status: integrationStatusSchema,
  enabled: z.boolean(),
  adapter: z.string(),
  /** True when the adapter is the labelled development adapter. */
  developmentAdapter: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), integrationSecretPresenceSchema),
  lastCheckAt: z.string().nullable(),
  lastCheckOk: z.boolean().nullable(),
  lastCheckMessage: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  credentialRotatedAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  activatedBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the operator should do next, derived from status and last check. */
  remedialAction: z.string().nullable(),
});
export type IntegrationConfigDto = z.infer<typeof integrationConfigDtoSchema>;

export const integrationEnvironmentSummarySchema = z.object({
  environment: integrationEnvironmentSchema,
  status: integrationStatusSchema,
  active: integrationConfigDtoSchema.nullable(),
  latest: integrationConfigDtoSchema.nullable(),
  versionCount: z.number().int(),
});

export const integrationOverviewItemSchema = z.object({
  provider: integrationProviderSchema,
  name: z.string(),
  summary: z.string(),
  environments: z.array(integrationEnvironmentSummarySchema),
});
export type IntegrationOverviewItem = z.infer<typeof integrationOverviewItemSchema>;

export const integrationOverviewResponseSchema = z.object({
  items: z.array(integrationOverviewItemSchema),
  appEnv: z.string(),
  /** Environment the runtime reads by default (`live` in production, else `test`). */
  defaultEnvironment: integrationEnvironmentSchema,
  masterKeyId: z.string(),
  secretsNeedingRewrap: z.number().int(),
  permissions: z.object({
    manage: z.boolean(),
    test: z.boolean(),
    rotate: z.boolean(),
    paymentCredentials: z.boolean(),
    mfaVerified: z.boolean(),
  }),
});
export type IntegrationOverviewResponse = z.infer<typeof integrationOverviewResponseSchema>;

export const integrationDetailResponseSchema = z.object({
  descriptor: integrationProviderDescriptorSchema,
  environments: z.array(
    z.object({
      environment: integrationEnvironmentSchema,
      active: integrationConfigDtoSchema.nullable(),
      versions: z.array(integrationConfigDtoSchema),
    }),
  ),
  appEnv: z.string(),
  defaultEnvironment: integrationEnvironmentSchema,
});
export type IntegrationDetailResponse = z.infer<typeof integrationDetailResponseSchema>;

export const integrationEnvironmentQuerySchema = z.object({
  environment: integrationEnvironmentSchema.optional(),
});

/** PUT /api/v1/admin/integrations/:provider — saves a NEW version; never activates. */
export const integrationSaveSchema = z.object({
  environment: integrationEnvironmentSchema,
  adapter: z.string().min(1).max(40),
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Only fields being (re)entered; omitted fields are carried over from the latest version. */
  secrets: z.record(z.string(), z.string().min(1).max(4096)).default({}),
  /** Fields to clear (secret removed from the new version). */
  clearSecrets: z.array(z.string()).default([]),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>;

export const integrationVersionRefSchema = z.object({
  environment: integrationEnvironmentSchema,
  /** Defaults to the latest saved version. */
  version: z.number().int().min(1).optional(),
});

export const integrationTestSchema = integrationVersionRefSchema;

export const integrationActivateSchema = integrationVersionRefSchema.extend({
  /** Activate without a passed test; requires a reason and is audited. */
  force: z.boolean().default(false),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const integrationDisableSchema = z.object({
  environment: integrationEnvironmentSchema,
  reason: z.string().trim().min(3).max(500),
});

export const integrationRotateSecretSchema = z.object({
  environment: integrationEnvironmentSchema,
  field: z.string().min(1).max(64),
  value: z.string().min(1).max(4096),
  reason: z.string().trim().min(3).max(500),
});

export const integrationCheckResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkedAt: z.string(),
  /** `development` when a labelled development adapter answered. */
  mode: z.enum(['development', 'real']),
  adapter: z.string(),
  environmentDetected: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  config: integrationConfigDtoSchema,
});
export type IntegrationCheckResult = z.infer<typeof integrationCheckResultSchema>;

export const integrationRotateResultSchema = z.object({
  config: integrationConfigDtoSchema,
  retiredSecretId: uuidSchema.nullable(),
  /** Result of the verification run against the rotated version, when one ran. */
  check: integrationCheckResultSchema.omit({ config: true }).nullable(),
  activated: z.boolean(),
});

export const integrationRewrapResponseSchema = z.object({
  jobId: uuidSchema,
  deduplicated: z.boolean(),
  masterKeyId: z.string(),
  /** Non-retired secrets whose wrapping key differs from the current master key. */
  pending: z.number().int(),
  total: z.number().int(),
});

export const integrationLogDtoSchema = z.object({
  id: uuidSchema,
  provider: z.string(),
  environment: z.string(),
  level: z.string(),
  event: z.string(),
  message: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string(),
});
export type IntegrationLogDto = z.infer<typeof integrationLogDtoSchema>;

export const integrationLogsQuerySchema = z.object({
  environment: integrationEnvironmentSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const integrationLogsResponseSchema = z.object({ items: z.array(integrationLogDtoSchema) });

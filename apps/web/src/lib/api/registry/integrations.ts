import { z } from 'zod';
import {
  integrationActivateSchema,
  integrationCheckResultSchema,
  integrationConfigDtoSchema,
  integrationDetailResponseSchema,
  integrationDisableSchema,
  integrationLogsQuerySchema,
  integrationLogsResponseSchema,
  integrationOverviewResponseSchema,
  integrationProviderSchema,
  integrationRewrapResponseSchema,
  integrationRotateResultSchema,
  integrationRotateSecretSchema,
  integrationSaveSchema,
  integrationTestSchema,
  listRoutes,
  registerRoute,
  type RouteSpec,
} from '@simplexd/contracts';

/**
 * OpenAPI registrations for Admin → Integrations. Registration is idempotent
 * so hot reloads never trip the duplicate-operation guard. No response schema
 * here carries a secret value: only presence, fingerprint and timestamps.
 */

function ensure(spec: RouteSpec): RouteSpec {
  const existing = listRoutes().find((r) => r.operationId === spec.operationId);
  return existing ?? registerRoute(spec);
}

const providerParams = z.object({ provider: integrationProviderSchema });
const tags = ['admin', 'integrations'];

export const integrationsListRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/integrations',
  summary: 'Integration status per provider and environment',
  description:
    'Masked secrets (fingerprint presence only), last check result/time, active version and adapter for each provider. Requires integrations.read.',
  tags,
  operationId: 'admin.integrations.list',
  auth: 'staff',
  responses: { 200: { description: 'Overview', body: integrationOverviewResponseSchema } },
});

export const integrationGetRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/integrations/{provider}',
  summary: 'Provider descriptor and version history',
  tags,
  operationId: 'admin.integrations.get',
  auth: 'staff',
  request: { params: providerParams },
  responses: { 200: { description: 'Detail', body: integrationDetailResponseSchema } },
});

export const integrationSaveRoute = ensure({
  method: 'put',
  path: '/api/v1/admin/integrations/{provider}',
  summary: 'Save a new configuration version',
  description:
    'Writes a new version in configured_unverified. Provided secrets are envelope-encrypted; omitted secrets are carried over. Saving never activates. Requires integrations.manage with MFA; Paystack secrets additionally need integrations.payment_credentials.manage.',
  tags,
  operationId: 'admin.integrations.save',
  auth: 'staff',
  request: { params: providerParams, body: integrationSaveSchema },
  responses: {
    201: { description: 'Version saved', body: integrationConfigDtoSchema },
    400: { description: 'Validation failed (including test/live key mismatch)' },
    403: { description: 'Forbidden or MFA required' },
  },
});

export const integrationTestRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/integrations/{provider}/test',
  summary: 'Run the real connection test on a saved version',
  description:
    'Executes the adapter check (Paystack testConnection, Termii balance/sender ID, SMTP verify + DNS, storage head, scanner ping, map style validation) and records the honest result. Development adapters are labelled. Requires integrations.test.',
  tags,
  operationId: 'admin.integrations.test',
  auth: 'staff',
  request: { params: providerParams, body: integrationTestSchema },
  responses: { 200: { description: 'Check result', body: integrationCheckResultSchema } },
});

export const integrationActivateRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/integrations/{provider}/activate',
  summary: 'Activate a tested version',
  description:
    'Deactivates the previous version and activates this one atomically. Requires a passed test on the version unless force is set with a reason (audited). Production refuses development adapters; Paystack key prefixes must match the environment.',
  tags,
  operationId: 'admin.integrations.activate',
  auth: 'staff',
  request: { params: providerParams, body: integrationActivateSchema },
  responses: {
    200: { description: 'Active version', body: integrationConfigDtoSchema },
    409: { description: 'Not tested, dev adapter in production or key mismatch' },
  },
});

export const integrationDisableRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/integrations/{provider}/disable',
  summary: 'Disable the active configuration',
  tags,
  operationId: 'admin.integrations.disable',
  auth: 'staff',
  request: { params: providerParams, body: integrationDisableSchema },
  responses: { 200: { description: 'Disabled version', body: integrationConfigDtoSchema } },
});

export const integrationRotateSecretRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/integrations/{provider}/rotate-secret',
  summary: 'Rotate one secret',
  description:
    'Stores the new value as a fresh secret record, retires the previous record and bumps the configuration version keeping the other secrets. When the rotated version was active, the new version is verified and activated only if the check passes. The old secret is never returned. Requires integrations.secrets.rotate with MFA.',
  tags,
  operationId: 'admin.integrations.rotateSecret',
  auth: 'staff',
  request: { params: providerParams, body: integrationRotateSecretSchema },
  responses: { 200: { description: 'Rotation result', body: integrationRotateResultSchema } },
});

export const integrationRewrapRoute = ensure({
  method: 'post',
  path: '/api/v1/admin/integrations/rewrap',
  summary: 'Re-wrap stored secrets under the current master key',
  description:
    'Enqueues the integrations.rewrap_secrets job, which re-wraps every non-retired secret whose master key id differs from SECRETS_MASTER_KEY_ID. Reports how many are pending.',
  tags,
  operationId: 'admin.integrations.rewrap',
  auth: 'staff',
  responses: { 202: { description: 'Job enqueued', body: integrationRewrapResponseSchema } },
});

export const integrationLogsRoute = ensure({
  method: 'get',
  path: '/api/v1/admin/integrations/{provider}/logs',
  summary: 'Sanitized integration log',
  tags,
  operationId: 'admin.integrations.logs',
  auth: 'staff',
  request: { params: providerParams, query: integrationLogsQuerySchema },
  responses: { 200: { description: 'Log entries', body: integrationLogsResponseSchema } },
});

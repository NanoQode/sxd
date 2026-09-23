import 'server-only';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  ApiError,
  INTEGRATION_PROVIDERS,
  type IntegrationCheckResult,
  type IntegrationConfigDto,
  type IntegrationDetailResponse,
  type IntegrationEnvironment,
  type IntegrationLogDto,
  type IntegrationOverviewResponse,
  type IntegrationProvider,
  type IntegrationSaveInput,
  type IntegrationSecretPresence,
  type IntegrationStatus,
} from '@simplexd/contracts';
import { enqueueJob, schema, type DbExecutor, type Transaction } from '@simplexd/db';
import type { StaffPermission } from '@simplexd/domain/authz';
import { detectKeyEnvironment } from '@simplexd/integrations/payments';
import {
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  maskSecretPresence,
  type Keyring,
} from '@simplexd/integrations/secrets';
import { recordAudit } from '@/lib/audit';
import { actorId, authorize, can, iso, transact, type AdminContext } from '@/server/admin/context';
import {
  adapterAllowed,
  catalogEntry,
  defaultEnvironmentFor,
  isDevelopmentAdapter,
  PROVIDER_CATALOG,
} from './catalog';
import { runProviderCheck, scrubSecrets, type CheckOutcome } from './checks';

/**
 * Admin → Integrations server functions (brief §16).
 *
 * Save, test and activate are separate operations:
 * - `saveIntegration` writes a NEW configuration version in
 *   `configured_unverified`; it never activates anything.
 * - `testIntegration` runs the real adapter check against a saved version and
 *   records the honest result.
 * - `activateIntegration` flips `is_active` atomically and requires a passed
 *   test on that version (or an audited `force` with a reason).
 *
 * Secrets are envelope-encrypted into `secret_references`; responses carry
 * only presence, fingerprint and timestamps. Plaintext is decrypted for the
 * duration of a check and scrubbed from every message before it is stored.
 */

export interface IntegrationServiceOptions {
  keyring?: Keyring;
  appEnv?: string;
  nodeEnv?: string;
  appUrl?: string;
  now?: () => Date;
  /** Skip the network-facing check (used by tests that only exercise persistence). */
  checkTimeoutMs?: number;
}

type ConfigRow = typeof schema.integrationConfigs.$inferSelect;
type SecretRow = typeof schema.secretReferences.$inferSelect;
type SecretMeta = Pick<
  SecretRow,
  'id' | 'fieldName' | 'fingerprint' | 'createdAt' | 'masterKeyId' | 'retiredAt' | 'rotatedAt'
>;

const ENVIRONMENTS: IntegrationEnvironment[] = ['test', 'live'];

function resolve(opts: IntegrationServiceOptions) {
  return {
    keyring: opts.keyring ?? keyringFromEnv(),
    appEnv: opts.appEnv ?? process.env.APP_ENV ?? 'development',
    nodeEnv: opts.nodeEnv ?? process.env.NODE_ENV ?? 'development',
    appUrl: (opts.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    now: opts.now ?? (() => new Date()),
    checkTimeoutMs: opts.checkTimeoutMs,
  };
}

function providerOrThrow(value: string): IntegrationProvider {
  if ((INTEGRATION_PROVIDERS as readonly string[]).includes(value))
    return value as IntegrationProvider;
  throw new ApiError('not_found', `unknown integration provider ${value}`);
}

function remedialAction(row: ConfigRow): string | null {
  switch (row.status) {
    case 'disconnected':
      return row.isActive
        ? 'This version was superseded; activate a tested version.'
        : 'Save settings and secrets, then run the connection test.';
    case 'configured_unverified':
      if (row.lastCheckOk === true) return 'Test passed on this version; activate it to start using it.';
      if (row.lastCheckOk === false)
        return `Last test failed: ${row.lastCheckMessage ?? 'no details'}. Fix the settings or credentials, save and test again.`;
      return 'Run the connection test before activating.';
    case 'connected':
      return null;
    case 'degraded':
      return `Health check failed: ${row.lastCheckMessage ?? 'no details'}. Re-run the test; if it keeps failing, re-enter or rotate the credentials.`;
    case 'expired':
      return 'The provider rejected the credentials. Rotate the secret, test the new version and activate it.';
    case 'disabled':
      return 'Disabled by an administrator. Save a new version (or re-test this one) and activate it to resume.';
  }
}

function presenceFor(
  provider: IntegrationProvider,
  row: ConfigRow,
  secretsById: Map<string, SecretMeta>,
): Record<string, IntegrationSecretPresence> {
  const out: Record<string, IntegrationSecretPresence> = {};
  for (const key of Object.keys(catalogEntry(provider).secretFields)) {
    const id = row.secretIds?.[key];
    const meta = id ? secretsById.get(id) : undefined;
    if (!meta || meta.retiredAt) {
      out[key] = {
        set: false,
        fingerprint: null,
        masked: maskSecretPresence(null, null),
        updatedAt: null,
        masterKeyId: null,
      };
      continue;
    }
    out[key] = {
      set: true,
      fingerprint: meta.fingerprint.slice(0, 8),
      masked: maskSecretPresence(null, meta.fingerprint),
      updatedAt: iso(meta.createdAt),
      masterKeyId: meta.masterKeyId,
    };
  }
  return out;
}

function toDto(row: ConfigRow, secretsById: Map<string, SecretMeta>): IntegrationConfigDto {
  const provider = row.provider as IntegrationProvider;
  return {
    id: row.id,
    provider,
    environment: row.environment,
    version: row.version,
    isActive: row.isActive,
    status: row.status,
    enabled: row.enabled,
    adapter: row.adapter,
    developmentAdapter: isDevelopmentAdapter(provider, row.adapter),
    settings: (row.settings ?? {}) as Record<string, unknown>,
    secrets: presenceFor(provider, row, secretsById),
    lastCheckAt: iso(row.lastCheckAt),
    lastCheckOk: row.lastCheckOk,
    lastCheckMessage: row.lastCheckMessage,
    lastSuccessAt: iso(row.lastSuccessAt),
    credentialRotatedAt: iso(row.credentialRotatedAt),
    activatedAt: iso(row.activatedAt),
    activatedBy: row.activatedBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    remedialAction: remedialAction(row),
  };
}

async function secretMeta(tx: DbExecutor, rows: ConfigRow[]): Promise<Map<string, SecretMeta>> {
  const ids = [...new Set(rows.flatMap((r) => Object.values(r.secretIds ?? {})))];
  if (ids.length === 0) return new Map();
  const metas = await tx
    .select({
      id: schema.secretReferences.id,
      fieldName: schema.secretReferences.fieldName,
      fingerprint: schema.secretReferences.fingerprint,
      createdAt: schema.secretReferences.createdAt,
      masterKeyId: schema.secretReferences.masterKeyId,
      retiredAt: schema.secretReferences.retiredAt,
      rotatedAt: schema.secretReferences.rotatedAt,
    })
    .from(schema.secretReferences)
    .where(inArray(schema.secretReferences.id, ids));
  return new Map(metas.map((m) => [m.id, m]));
}

async function loadRows(
  tx: DbExecutor,
  provider: IntegrationProvider,
  environment?: IntegrationEnvironment,
): Promise<ConfigRow[]> {
  return tx
    .select()
    .from(schema.integrationConfigs)
    .where(
      environment
        ? and(
            eq(schema.integrationConfigs.provider, provider),
            eq(schema.integrationConfigs.environment, environment),
          )
        : eq(schema.integrationConfigs.provider, provider),
    )
    .orderBy(desc(schema.integrationConfigs.version));
}

async function loadVersion(
  tx: DbExecutor,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
  version?: number,
): Promise<ConfigRow> {
  const rows = await loadRows(tx, provider, environment);
  const row = version === undefined ? rows[0] : rows.find((r) => r.version === version);
  if (!row)
    throw new ApiError(
      'not_found',
      version === undefined
        ? `${provider} has no saved configuration for the ${environment} environment`
        : `${provider} ${environment} version ${version} not found`,
    );
  return row;
}

async function writeLog(
  tx: DbExecutor,
  input: {
    provider: string;
    environment: string;
    level?: 'info' | 'warn' | 'error';
    event: string;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
    correlationId?: string | null;
  },
): Promise<void> {
  await tx.insert(schema.integrationLogs).values({
    provider: input.provider,
    environment: input.environment,
    level: input.level ?? 'info',
    event: input.event,
    messageSanitized: input.message ?? null,
    metadataSanitized: input.metadata ?? null,
    correlationId: input.correlationId ?? null,
  });
}

async function decryptFor(
  tx: DbExecutor,
  row: ConfigRow,
  keyring: Keyring,
): Promise<{ secrets: Record<string, string>; problems: string[] }> {
  const ids = Object.values(row.secretIds ?? {});
  const secrets: Record<string, string> = {};
  const problems: string[] = [];
  if (ids.length === 0) return { secrets, problems };
  const records = await tx
    .select()
    .from(schema.secretReferences)
    .where(inArray(schema.secretReferences.id, ids));
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const [field, id] of Object.entries(row.secretIds ?? {})) {
    const record = byId.get(id);
    if (!record) {
      problems.push(`${field}: secret record missing`);
      continue;
    }
    if (record.retiredAt) {
      problems.push(`${field}: secret was retired (rotated); this version can no longer use it`);
      continue;
    }
    try {
      secrets[field] = decryptSecret(record, keyring);
    } catch (err) {
      problems.push(`${field}: cannot decrypt (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }
  return { secrets, problems };
}

function paystackKeyGuard(
  provider: IntegrationProvider,
  adapter: string,
  environment: IntegrationEnvironment,
  secrets: Record<string, string | undefined>,
): void {
  if (provider !== 'paystack' || isDevelopmentAdapter(provider, adapter)) return;
  const secretKey = secrets.secretKey;
  if (secretKey) {
    const detected = detectKeyEnvironment(secretKey);
    if (detected !== environment)
      throw new ApiError(
        'validation_failed',
        `Paystack secret key is a ${detected} key; the ${environment} environment only accepts sk_${environment}_ keys. Test and live credentials are never mixed.`,
        { details: [{ path: 'secrets.secretKey', message: `expected a ${environment} key` }] },
      );
  }
  const publicKey = secrets.publicKey;
  if (publicKey && !publicKey.startsWith(`pk_${environment}_`))
    throw new ApiError(
      'validation_failed',
      `Paystack public key must start with pk_${environment}_ for the ${environment} environment`,
      { details: [{ path: 'secrets.publicKey', message: `expected a ${environment} key` }] },
    );
}

function authorizeWrite(
  ctx: AdminContext,
  provider: IntegrationProvider,
  base: StaffPermission,
  touchesSecrets: boolean,
): void {
  authorize(ctx, base);
  const extra = catalogEntry(provider).descriptor.secretsPermission as StaffPermission | null;
  if (touchesSecrets && extra) authorize(ctx, extra);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listIntegrations(
  ctx: AdminContext,
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationOverviewResponse> {
  authorize(ctx, 'integrations.read');
  const { appEnv, keyring } = resolve(opts);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.integrationConfigs)
      .orderBy(desc(schema.integrationConfigs.version));
    const metas = await secretMeta(tx, rows);
    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.secretReferences)
      .where(
        and(
          isNull(schema.secretReferences.retiredAt),
          ne(schema.secretReferences.masterKeyId, keyring.current.id),
        ),
      );
    const items = INTEGRATION_PROVIDERS.map((provider) => {
      const descriptor = PROVIDER_CATALOG[provider].descriptor;
      return {
        provider,
        name: descriptor.name,
        summary: descriptor.summary,
        environments: ENVIRONMENTS.map((environment) => {
          const mine = rows.filter((r) => r.provider === provider && r.environment === environment);
          const active = mine.find((r) => r.isActive) ?? null;
          const latest = mine[0] ?? null;
          const status: IntegrationStatus = active?.status ?? latest?.status ?? 'disconnected';
          return {
            environment,
            status,
            active: active ? toDto(active, metas) : null,
            latest: latest ? toDto(latest, metas) : null,
            versionCount: mine.length,
          };
        }),
      };
    });
    return {
      items,
      appEnv,
      defaultEnvironment: defaultEnvironmentFor(appEnv),
      masterKeyId: keyring.current.id,
      secretsNeedingRewrap: pending?.count ?? 0,
      permissions: {
        manage: can(ctx, 'integrations.manage'),
        test: can(ctx, 'integrations.test'),
        rotate: can(ctx, 'integrations.secrets.rotate'),
        paymentCredentials: can(ctx, 'integrations.payment_credentials.manage'),
        mfaVerified: ctx.identity.actor.mfaVerified,
      },
    };
  });
}

export async function getIntegration(
  ctx: AdminContext,
  providerName: string,
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationDetailResponse> {
  authorize(ctx, 'integrations.read');
  const provider = providerOrThrow(providerName);
  const { appEnv } = resolve(opts);
  return transact(ctx, async (tx) => {
    const rows = await loadRows(tx, provider);
    const metas = await secretMeta(tx, rows);
    return {
      descriptor: PROVIDER_CATALOG[provider].descriptor,
      environments: ENVIRONMENTS.map((environment) => {
        const mine = rows.filter((r) => r.environment === environment);
        const active = mine.find((r) => r.isActive) ?? null;
        return {
          environment,
          active: active ? toDto(active, metas) : null,
          versions: mine.map((r) => toDto(r, metas)),
        };
      }),
      appEnv,
      defaultEnvironment: defaultEnvironmentFor(appEnv),
    };
  });
}

export async function listIntegrationLogs(
  ctx: AdminContext,
  providerName: string,
  query: { environment?: IntegrationEnvironment; limit?: number },
): Promise<IntegrationLogDto[]> {
  authorize(ctx, 'integrations.read');
  const provider = providerOrThrow(providerName);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.integrationLogs)
      .where(
        query.environment
          ? and(
              eq(schema.integrationLogs.provider, provider),
              eq(schema.integrationLogs.environment, query.environment),
            )
          : eq(schema.integrationLogs.provider, provider),
      )
      .orderBy(desc(schema.integrationLogs.createdAt))
      .limit(query.limit ?? 50);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      environment: r.environment,
      level: r.level,
      event: r.event,
      message: r.messageSanitized,
      metadata: (r.metadataSanitized ?? null) as Record<string, unknown> | null,
      correlationId: r.correlationId,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

// ---------------------------------------------------------------------------
// Save (new version, never active)
// ---------------------------------------------------------------------------

export async function saveIntegration(
  ctx: AdminContext,
  providerName: string,
  input: IntegrationSaveInput,
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationConfigDto> {
  const provider = providerOrThrow(providerName);
  const entry = catalogEntry(provider);
  const touchesSecrets = Object.keys(input.secrets).length > 0 || input.clearSecrets.length > 0;
  authorizeWrite(ctx, provider, 'integrations.manage', touchesSecrets);
  if (!adapterAllowed(provider, input.adapter))
    throw new ApiError('validation_failed', `adapter ${input.adapter} is not available for ${provider}`, {
      details: [{ path: 'adapter', message: 'unknown adapter' }],
    });
  const settings = entry.settingsSchema.parse(input.settings) as Record<string, unknown>;
  for (const key of [...Object.keys(input.secrets), ...input.clearSecrets]) {
    if (!(key in entry.secretFields))
      throw new ApiError('validation_failed', `${provider} has no secret field ${key}`, {
        details: [{ path: `secrets.${key}`, message: 'unknown secret field' }],
      });
  }
  paystackKeyGuard(provider, input.adapter, input.environment, input.secrets);
  const { keyring, now } = resolve(opts);
  const userId = actorId(ctx);

  return transact(ctx, async (tx) => {
    const existing = await loadRows(tx, provider, input.environment);
    const latest = existing[0] ?? null;
    const secretIds: Record<string, string> = {};
    for (const [field, id] of Object.entries(latest?.secretIds ?? {})) {
      if (field in entry.secretFields && !input.clearSecrets.includes(field)) secretIds[field] = id;
    }
    const changed: string[] = [];
    const fingerprints: Record<string, string> = {};
    for (const [field, value] of Object.entries(input.secrets)) {
      const encrypted = encryptSecret(value, keyring);
      const [previous] = await tx
        .select({ version: schema.secretReferences.version })
        .from(schema.secretReferences)
        .where(
          and(
            eq(schema.secretReferences.provider, provider),
            eq(schema.secretReferences.environment, input.environment),
            eq(schema.secretReferences.fieldName, field),
          ),
        )
        .orderBy(desc(schema.secretReferences.version))
        .limit(1);
      const [row] = await tx
        .insert(schema.secretReferences)
        .values({
          provider,
          environment: input.environment,
          fieldName: field,
          version: (previous?.version ?? 0) + 1,
          createdBy: userId,
          ...encrypted,
        })
        .returning({ id: schema.secretReferences.id });
      secretIds[field] = row!.id;
      changed.push(field);
      fingerprints[field] = encrypted.fingerprint.slice(0, 8);
    }
    const secretsChanged = changed.length > 0 || input.clearSecrets.length > 0;
    const [row] = await tx
      .insert(schema.integrationConfigs)
      .values({
        provider,
        environment: input.environment,
        version: (latest?.version ?? 0) + 1,
        isActive: false,
        status: 'configured_unverified',
        enabled: false,
        settings,
        secretIds,
        adapter: input.adapter,
        credentialRotatedAt: secretsChanged ? now() : (latest?.credentialRotatedAt ?? null),
        updatedBy: userId,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'integration.saved',
      entityType: 'integration_config',
      entityId: row!.id,
      before: latest
        ? { version: latest.version, adapter: latest.adapter, settings: latest.settings }
        : null,
      after: {
        version: row!.version,
        adapter: row!.adapter,
        settings,
        secretsChanged: changed,
        secretsCleared: input.clearSecrets,
        fingerprints,
      },
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    await writeLog(tx, {
      provider,
      environment: input.environment,
      event: 'config.saved',
      message: `Version ${row!.version} saved (${row!.adapter}); not yet tested or active`,
      metadata: { version: row!.version, secretsChanged: changed, by: userId },
      correlationId: ctx.correlationId,
    });
    const metas = await secretMeta(tx, [row!]);
    return toDto(row!, metas);
  });
}

// ---------------------------------------------------------------------------
// Test (real adapter check, recorded on the version)
// ---------------------------------------------------------------------------

async function runCheckOn(
  ctx: AdminContext,
  tx: Transaction,
  row: ConfigRow,
  opts: IntegrationServiceOptions,
): Promise<{ outcome: CheckOutcome; updated: ConfigRow }> {
  const { keyring, appEnv, nodeEnv, appUrl, now, checkTimeoutMs } = resolve(opts);
  const provider = row.provider as IntegrationProvider;
  const { secrets, problems } = await decryptFor(tx, row, keyring);
  let outcome: CheckOutcome;
  if (problems.length > 0) {
    outcome = {
      ok: false,
      message: `Secrets unavailable: ${problems.join('; ')}`,
      mode: isDevelopmentAdapter(provider, row.adapter) ? 'development' : 'real',
      environmentDetected: null,
      details: { problems },
      credentialInvalid: true,
    };
  } else {
    outcome = await runProviderCheck({
      provider,
      environment: row.environment,
      adapter: row.adapter,
      settings: (row.settings ?? {}) as Record<string, unknown>,
      secrets,
      appEnv,
      nodeEnv,
      appUrl,
      db: tx,
      smtpAllowedHosts: (process.env.SMTP_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      ...(checkTimeoutMs ? { timeoutMs: checkTimeoutMs } : {}),
    });
  }
  const checkedAt = now();
  const nextStatus: IntegrationStatus = row.isActive
    ? outcome.ok
      ? 'connected'
      : outcome.credentialInvalid
        ? 'expired'
        : 'degraded'
    : row.status;
  const [updated] = await tx
    .update(schema.integrationConfigs)
    .set({
      lastCheckAt: checkedAt,
      lastCheckOk: outcome.ok,
      lastCheckMessage: outcome.message,
      lastSuccessAt: outcome.ok ? checkedAt : row.lastSuccessAt,
      status: nextStatus,
      updatedAt: checkedAt,
    })
    .where(eq(schema.integrationConfigs.id, row.id))
    .returning();
  await writeLog(tx, {
    provider,
    environment: row.environment,
    level: outcome.ok ? 'info' : 'warn',
    event: 'connection.test',
    message: outcome.message,
    metadata: {
      version: row.version,
      ok: outcome.ok,
      mode: outcome.mode,
      adapter: row.adapter,
      details: outcome.details,
      by: ctx.identity.session?.user.id ?? null,
    },
    correlationId: ctx.correlationId,
  });
  return { outcome, updated: updated! };
}

export async function testIntegration(
  ctx: AdminContext,
  providerName: string,
  input: { environment: IntegrationEnvironment; version?: number },
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationCheckResult> {
  authorize(ctx, 'integrations.test');
  const provider = providerOrThrow(providerName);
  return transact(ctx, async (tx) => {
    const row = await loadVersion(tx, provider, input.environment, input.version);
    const { outcome, updated } = await runCheckOn(ctx, tx, row, opts);
    await recordAudit(tx, ctx.identity, {
      action: 'integration.tested',
      entityType: 'integration_config',
      entityId: row.id,
      after: { version: row.version, ok: outcome.ok, mode: outcome.mode, message: outcome.message },
      correlationId: ctx.correlationId,
    });
    const metas = await secretMeta(tx, [updated]);
    return {
      ok: outcome.ok,
      message: outcome.message,
      checkedAt: updated.lastCheckAt!.toISOString(),
      mode: outcome.mode,
      adapter: row.adapter,
      environmentDetected: outcome.environmentDetected,
      details: outcome.details,
      config: toDto(updated, metas),
    };
  });
}

// ---------------------------------------------------------------------------
// Activate / disable
// ---------------------------------------------------------------------------

async function activateRow(
  ctx: AdminContext,
  tx: Transaction,
  row: ConfigRow,
  input: { force: boolean; reason?: string },
  opts: IntegrationServiceOptions,
): Promise<ConfigRow> {
  const { keyring, appEnv, now } = resolve(opts);
  const provider = row.provider as IntegrationProvider;
  const entry = catalogEntry(provider);
  const dev = isDevelopmentAdapter(provider, row.adapter);
  if (appEnv === 'production' && dev)
    throw new ApiError(
      'invalid_transition',
      `${entry.descriptor.name}: the ${row.adapter} adapter is a development adapter and cannot be activated in production`,
    );
  if (!dev) {
    const missing = Object.entries(entry.secretFields)
      .filter(([field, def]) => def.required && !row.secretIds?.[field])
      .map(([field]) => field);
    if (missing.length > 0)
      throw new ApiError(
        'invalid_transition',
        `cannot activate: required secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not set on version ${row.version}`,
      );
    const { secrets, problems } = await decryptFor(tx, row, keyring);
    if (problems.length > 0)
      throw new ApiError('invalid_transition', `cannot activate: ${problems.join('; ')}`);
    paystackKeyGuard(provider, row.adapter, row.environment, secrets);
  }
  if (row.lastCheckOk !== true) {
    if (!input.force)
      throw new ApiError(
        'invalid_transition',
        row.lastCheckOk === false
          ? `version ${row.version} failed its last connection test (${row.lastCheckMessage ?? 'no details'}); fix and re-test before activating`
          : `version ${row.version} has not passed a connection test; run "Test connection" first`,
      );
    if (!input.reason || input.reason.trim().length < 3)
      throw new ApiError('validation_failed', 'forcing activation without a passed test requires a reason', {
        details: [{ path: 'reason', message: 'required with force' }],
      });
  }
  const at = now();
  const userId = actorId(ctx);
  const previous = await tx
    .update(schema.integrationConfigs)
    .set({ isActive: false, enabled: false, status: 'disconnected', updatedBy: userId, updatedAt: at })
    .where(
      and(
        eq(schema.integrationConfigs.provider, provider),
        eq(schema.integrationConfigs.environment, row.environment),
        eq(schema.integrationConfigs.isActive, true),
        ne(schema.integrationConfigs.id, row.id),
      ),
    )
    .returning({ id: schema.integrationConfigs.id, version: schema.integrationConfigs.version });
  const status: IntegrationStatus = row.lastCheckOk === true ? 'connected' : 'configured_unverified';
  const [updated] = await tx
    .update(schema.integrationConfigs)
    .set({
      isActive: true,
      enabled: true,
      status,
      activatedAt: at,
      activatedBy: userId,
      updatedBy: userId,
      updatedAt: at,
    })
    .where(eq(schema.integrationConfigs.id, row.id))
    .returning();
  await recordAudit(tx, ctx.identity, {
    action: 'integration.activated',
    entityType: 'integration_config',
    entityId: row.id,
    before: { activeVersion: previous[0]?.version ?? null },
    after: { activeVersion: row.version, status, forced: row.lastCheckOk !== true, adapter: row.adapter },
    reason: input.reason ?? null,
    correlationId: ctx.correlationId,
  });
  await writeLog(tx, {
    provider,
    environment: row.environment,
    level: status === 'connected' ? 'info' : 'warn',
    event: 'config.activated',
    message:
      status === 'connected'
        ? `Version ${row.version} activated (${row.adapter})${previous[0] ? `, replacing version ${previous[0].version}` : ''}`
        : `Version ${row.version} force-activated WITHOUT a passed test (${row.adapter})`,
    metadata: { version: row.version, previousVersion: previous[0]?.version ?? null, by: userId },
    correlationId: ctx.correlationId,
  });
  return updated!;
}

export async function activateIntegration(
  ctx: AdminContext,
  providerName: string,
  input: { environment: IntegrationEnvironment; version?: number; force?: boolean; reason?: string },
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationConfigDto> {
  const provider = providerOrThrow(providerName);
  authorizeWrite(ctx, provider, 'integrations.manage', true);
  return transact(ctx, async (tx) => {
    const row = await loadVersion(tx, provider, input.environment, input.version);
    const updated = row.isActive
      ? row
      : await activateRow(ctx, tx, row, { force: input.force ?? false, reason: input.reason }, opts);
    const metas = await secretMeta(tx, [updated]);
    return toDto(updated, metas);
  });
}

export async function disableIntegration(
  ctx: AdminContext,
  providerName: string,
  input: { environment: IntegrationEnvironment; reason: string },
  opts: IntegrationServiceOptions = {},
): Promise<IntegrationConfigDto> {
  const provider = providerOrThrow(providerName);
  authorizeWrite(ctx, provider, 'integrations.manage', false);
  const { now } = resolve(opts);
  return transact(ctx, async (tx) => {
    const rows = await loadRows(tx, provider, input.environment);
    const target = rows.find((r) => r.isActive) ?? rows[0];
    if (!target) throw new ApiError('not_found', `${provider} has no configuration to disable`);
    const at = now();
    const userId = actorId(ctx);
    const [updated] = await tx
      .update(schema.integrationConfigs)
      .set({ isActive: false, enabled: false, status: 'disabled', updatedBy: userId, updatedAt: at })
      .where(eq(schema.integrationConfigs.id, target.id))
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'integration.disabled',
      entityType: 'integration_config',
      entityId: target.id,
      before: { status: target.status, isActive: target.isActive },
      after: { status: 'disabled', isActive: false },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    await writeLog(tx, {
      provider,
      environment: input.environment,
      level: 'warn',
      event: 'config.disabled',
      message: `Version ${target.version} disabled: ${input.reason}`,
      metadata: { version: target.version, by: userId },
      correlationId: ctx.correlationId,
    });
    const metas = await secretMeta(tx, [updated!]);
    return toDto(updated!, metas);
  });
}

// ---------------------------------------------------------------------------
// Secret rotation
// ---------------------------------------------------------------------------

export interface RotateResult {
  config: IntegrationConfigDto;
  retiredSecretId: string | null;
  check: Omit<IntegrationCheckResult, 'config'> | null;
  activated: boolean;
}

/**
 * Rotation = new secret row + new configuration version (other secrets kept)
 * + the previous row retired. When the rotated version was active, the new
 * version is verified immediately and activated only if the check passes;
 * otherwise the old version is marked `expired` (its secret is gone) so the
 * failure is visible instead of silently continuing with a dead credential.
 */
export async function rotateIntegrationSecret(
  ctx: AdminContext,
  providerName: string,
  input: { environment: IntegrationEnvironment; field: string; value: string; reason: string },
  opts: IntegrationServiceOptions = {},
): Promise<RotateResult> {
  const provider = providerOrThrow(providerName);
  const entry = catalogEntry(provider);
  authorize(ctx, 'integrations.secrets.rotate');
  const extra = entry.descriptor.secretsPermission as StaffPermission | null;
  if (extra) authorize(ctx, extra);
  if (!(input.field in entry.secretFields))
    throw new ApiError('validation_failed', `${provider} has no secret field ${input.field}`, {
      details: [{ path: 'field', message: 'unknown secret field' }],
    });
  const { keyring, now } = resolve(opts);
  const userId = actorId(ctx);

  return transact(ctx, async (tx) => {
    const rows = await loadRows(tx, provider, input.environment);
    const source = rows.find((r) => r.isActive) ?? rows[0];
    if (!source) throw new ApiError('not_found', `${provider} has no saved configuration to rotate`);
    paystackKeyGuard(provider, source.adapter, input.environment, { [input.field]: input.value });
    const at = now();
    const oldId = source.secretIds?.[input.field] ?? null;
    const [previous] = await tx
      .select({ version: schema.secretReferences.version })
      .from(schema.secretReferences)
      .where(
        and(
          eq(schema.secretReferences.provider, provider),
          eq(schema.secretReferences.environment, input.environment),
          eq(schema.secretReferences.fieldName, input.field),
        ),
      )
      .orderBy(desc(schema.secretReferences.version))
      .limit(1);
    const encrypted = encryptSecret(input.value, keyring);
    const [fresh] = await tx
      .insert(schema.secretReferences)
      .values({
        provider,
        environment: input.environment,
        fieldName: input.field,
        version: (previous?.version ?? 0) + 1,
        createdBy: userId,
        rotatedAt: at,
        ...encrypted,
      })
      .returning({ id: schema.secretReferences.id });
    if (oldId) {
      await tx
        .update(schema.secretReferences)
        .set({ retiredAt: at, rotatedAt: at })
        .where(eq(schema.secretReferences.id, oldId));
    }
    const [created] = await tx
      .insert(schema.integrationConfigs)
      .values({
        provider,
        environment: input.environment,
        version: rows[0]!.version + 1,
        isActive: false,
        status: 'configured_unverified',
        enabled: false,
        settings: source.settings,
        secretIds: { ...(source.secretIds ?? {}), [input.field]: fresh!.id },
        adapter: source.adapter,
        credentialRotatedAt: at,
        updatedBy: userId,
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'integration.secret_rotated',
      entityType: 'integration_config',
      entityId: created!.id,
      before: { version: source.version, field: input.field, retiredSecretId: oldId },
      after: {
        version: created!.version,
        field: input.field,
        fingerprint: encrypted.fingerprint.slice(0, 8),
        newSecretId: fresh!.id,
      },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    await writeLog(tx, {
      provider,
      environment: input.environment,
      event: 'secret.rotated',
      message: `Secret ${input.field} rotated into version ${created!.version}; previous secret retired`,
      metadata: { field: input.field, version: created!.version, by: userId },
      correlationId: ctx.correlationId,
    });

    let check: RotateResult['check'] = null;
    let final = created!;
    let activated = false;
    if (source.isActive) {
      const { outcome, updated } = await runCheckOn(ctx, tx, created!, opts);
      check = {
        ok: outcome.ok,
        message: outcome.message,
        checkedAt: updated.lastCheckAt!.toISOString(),
        mode: outcome.mode,
        adapter: updated.adapter,
        environmentDetected: outcome.environmentDetected,
        details: outcome.details,
      };
      if (outcome.ok) {
        final = await activateRow(ctx, tx, updated, { force: false, reason: input.reason }, opts);
        activated = true;
      } else {
        final = updated;
        await tx
          .update(schema.integrationConfigs)
          .set({
            status: 'expired',
            lastCheckAt: at,
            lastCheckOk: false,
            lastCheckMessage: scrubSecrets(
              `Secret ${input.field} was rotated but version ${created!.version} failed its test: ${outcome.message}`,
              [input.value],
            ),
            updatedAt: at,
          })
          .where(eq(schema.integrationConfigs.id, source.id));
        await writeLog(tx, {
          provider,
          environment: input.environment,
          level: 'error',
          event: 'secret.rotation_unverified',
          message: `Rotated version ${created!.version} failed verification; active version ${source.version} marked expired`,
          metadata: { version: created!.version, sourceVersion: source.version },
          correlationId: ctx.correlationId,
        });
      }
    }
    const metas = await secretMeta(tx, [final]);
    return { config: toDto(final, metas), retiredSecretId: oldId, check, activated };
  });
}

// ---------------------------------------------------------------------------
// Master-key re-wrap
// ---------------------------------------------------------------------------

export async function requestRewrap(
  ctx: AdminContext,
  opts: IntegrationServiceOptions = {},
): Promise<{
  jobId: string;
  deduplicated: boolean;
  masterKeyId: string;
  pending: number;
  total: number;
}> {
  authorize(ctx, 'integrations.secrets.rotate');
  const { keyring, now } = resolve(opts);
  return transact(ctx, async (tx) => {
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${schema.secretReferences.masterKeyId} <> ${keyring.current.id})::int`,
      })
      .from(schema.secretReferences)
      .where(isNull(schema.secretReferences.retiredAt));
    const bucket = Math.floor(now().getTime() / 60_000);
    const job = await enqueueJob(tx, {
      type: 'integrations.rewrap_secrets',
      queue: 'default',
      payload: { masterKeyId: keyring.current.id, requestedBy: ctx.identity.session?.user.id ?? null },
      dedupeKey: `integrations.rewrap:${keyring.current.id}:${bucket}`,
      actorUserId: ctx.identity.session?.user.id ?? null,
      correlationId: ctx.correlationId,
      maxAttempts: 3,
    });
    await recordAudit(tx, ctx.identity, {
      action: 'integration.rewrap_requested',
      entityType: 'secret_references',
      entityId: keyring.current.id,
      after: { masterKeyId: keyring.current.id, pending: counts?.pending ?? 0, jobId: job.id },
      correlationId: ctx.correlationId,
    });
    return {
      jobId: job.id,
      deduplicated: job.deduplicated,
      masterKeyId: keyring.current.id,
      pending: counts?.pending ?? 0,
      total: counts?.total ?? 0,
    };
  });
}

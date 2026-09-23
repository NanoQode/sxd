import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, systemContext, withActor, type Database } from '@simplexd/db';
import { decryptSecret, keyringFromEnv, type Keyring } from '../secrets';

/**
 * Reads the active integration configuration for a provider and decrypts the
 * secrets it references. Integration tables are privileged-only under
 * row-level security, so the read runs as the system actor in its own short
 * transaction; the caller never receives ciphertext, wrapped keys or the
 * master key. Plaintext secrets must never be logged or persisted elsewhere.
 *
 * "Configured" is not "connected": `status` mirrors the admin-recorded state
 * (`disconnected`, `configured_unverified`, `connected`, `degraded`, `expired`,
 * `disabled`). Callers decide whether the dev adapter is acceptable for the
 * current APP_ENV; production never falls back to it silently.
 */

export type IntegrationProviderKey = (typeof schema.integrationProviderEnum.enumValues)[number];
export type IntegrationEnvironmentKey =
  (typeof schema.integrationEnvironmentEnum.enumValues)[number];
export type IntegrationStatusKey = (typeof schema.integrationStatusEnum.enumValues)[number];

export interface LoadedIntegrationConfig {
  id: string;
  provider: IntegrationProviderKey;
  environment: IntegrationEnvironmentKey;
  version: number;
  status: IntegrationStatusKey;
  enabled: boolean;
  /** Non-secret settings saved by the administrator (sender id, hostnames, ports...). */
  settings: Record<string, unknown>;
  /** Decrypted secrets keyed by field name (e.g. secretKey, publicKey, apiKey, password). */
  secrets: Record<string, string>;
  /** Fingerprints per secret field, safe to show in admin screens. */
  secretFingerprints: Record<string, string>;
  /** `dev` for labelled development adapters; otherwise the real adapter name. */
  adapter: string;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  activatedAt: Date | null;
}

export interface LoadIntegrationOptions {
  /** Defaults to `live` when APP_ENV=production and `test` otherwise. */
  environment?: IntegrationEnvironmentKey;
  keyring?: Keyring;
  appEnv?: string;
}

export function defaultIntegrationEnvironment(appEnv = process.env.APP_ENV): IntegrationEnvironmentKey {
  return appEnv === 'production' ? 'live' : 'test';
}

/**
 * Returns the active configuration for the provider/environment, or null when
 * the administrator has not activated one. Secrets whose master key is not in
 * the keyring raise an error naming the field so rotation problems surface
 * instead of silently degrading to an unauthenticated adapter.
 */
export async function loadIntegrationConfig(
  db: Database,
  provider: IntegrationProviderKey,
  options: LoadIntegrationOptions = {},
): Promise<LoadedIntegrationConfig | null> {
  const environment = options.environment ?? defaultIntegrationEnvironment(options.appEnv);
  const rows = await withActor(db, systemContext('integration-config'), async (tx) => {
    const [config] = await tx
      .select()
      .from(schema.integrationConfigs)
      .where(
        and(
          eq(schema.integrationConfigs.provider, provider),
          eq(schema.integrationConfigs.environment, environment),
          eq(schema.integrationConfigs.isActive, true),
        ),
      );
    if (!config) return null;
    const ids = Object.values(config.secretIds ?? {});
    const secretRows =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(schema.secretReferences)
            .where(
              and(
                inArray(schema.secretReferences.id, ids),
                isNull(schema.secretReferences.retiredAt),
              ),
            );
    return { config, secretRows };
  });
  if (!rows) return null;
  const { config, secretRows } = rows;
  const keyring = options.keyring ?? keyringFromEnv();
  const byId = new Map(secretRows.map((r) => [r.id, r]));
  const secrets: Record<string, string> = {};
  const secretFingerprints: Record<string, string> = {};
  for (const [field, secretId] of Object.entries(config.secretIds ?? {})) {
    const record = byId.get(secretId);
    if (!record) continue;
    secretFingerprints[field] = record.fingerprint;
    try {
      secrets[field] = decryptSecret(
        {
          masterKeyId: record.masterKeyId,
          wrappedDek: record.wrappedDek,
          dekIv: record.dekIv,
          dekTag: record.dekTag,
          ciphertext: record.ciphertext,
          iv: record.iv,
          tag: record.tag,
          fingerprint: record.fingerprint,
        },
        keyring,
      );
    } catch (err) {
      throw new Error(
        `integration ${provider}/${environment}: secret "${field}" cannot be decrypted (${
          err instanceof Error ? err.message : 'unknown error'
        }); re-enter it in Admin → Integrations`,
      );
    }
  }
  return {
    id: config.id,
    provider: config.provider,
    environment: config.environment,
    version: config.version,
    status: config.status,
    enabled: config.enabled,
    settings: (config.settings ?? {}) as Record<string, unknown>,
    secrets,
    secretFingerprints,
    adapter: config.adapter,
    lastCheckAt: config.lastCheckAt,
    lastCheckOk: config.lastCheckOk,
    lastCheckMessage: config.lastCheckMessage,
    activatedAt: config.activatedAt,
  };
}

/**
 * True when a provider may run in labelled development mode: never in
 * production, and only when no real configuration is active.
 */
export function devAdapterAllowed(appEnv = process.env.APP_ENV): boolean {
  return appEnv !== 'production';
}

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { appendOutbox, schema, systemContext, withActor, type Transaction } from '@simplexd/db';
import { createCalendarProvider } from '@simplexd/integrations/google';
import { createMailProvider } from '@simplexd/integrations/mail';
import { assertLicensedProvider, resolveMapConfig } from '@simplexd/integrations/maps';
import { createPaymentProvider } from '@simplexd/integrations/payments';
import { createMalwareScanner } from '@simplexd/integrations/scanner';
import {
  decryptSecret,
  keyringFromEnv,
  rewrapSecret,
  type Keyring,
} from '@simplexd/integrations/secrets';
import { createSmsProvider } from '@simplexd/integrations/sms';
import { createStorageProvider } from '@simplexd/integrations/storage';
import type { JobRunner } from '../runner';

/**
 * Integration jobs (brief §16):
 *
 * - `integrations.rewrap_secrets`: re-wraps every non-retired secret whose
 *   data key is wrapped by a master key other than the current one. Plaintext
 *   never leaves the process.
 * - `integrations.health_check` (hourly): re-runs the adapter check for every
 *   active configuration, moves it to `degraded`/`expired` on failure and back
 *   to `connected` on success, writes `integration_logs` and emits one
 *   `integration.degraded` outbox event per transition so administrators are
 *   notified once, not every hour.
 *
 * The per-provider checks mirror apps/web/src/server/integrations/checks.ts;
 * keep both in step when a provider is added.
 */

type ConfigRow = typeof schema.integrationConfigs.$inferSelect;

const DEV_ADAPTERS: Record<string, string> = {
  paystack: 'dev',
  termii: 'dev',
  smtp: 'dev',
  google_workspace: 'dev',
  storage: 'local-dev',
  scanner: 'dev',
  maps: 'dev',
};

const AUTH_FAILURE = /invalid key|unauthori[sz]ed|401|403|invalid api key|invalid_grant|forbidden|auth/i;

interface Outcome {
  ok: boolean;
  message: string;
  credentialInvalid: boolean;
  details: Record<string, unknown>;
}

function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const value of secrets) {
    if (value && value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}

const str = (s: Record<string, unknown>, k: string, d = ''): string =>
  typeof s[k] === 'string' ? (s[k] as string) : d;
const num = (s: Record<string, unknown>, k: string, d: number): number =>
  typeof s[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : d;
const bool = (s: Record<string, unknown>, k: string): boolean => s[k] === true;
const list = (s: Record<string, unknown>, k: string): string[] =>
  Array.isArray(s[k]) ? (s[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`check timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function decryptRow(
  tx: Transaction,
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
    if (!record || record.retiredAt) {
      problems.push(`${field}: secret ${record ? 'retired' : 'missing'}`);
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

async function checkRow(
  row: ConfigRow,
  secrets: Record<string, string>,
  env: { appEnv: string; nodeEnv: string; appUrl: string },
): Promise<Outcome> {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const dev = DEV_ADAPTERS[row.provider] === row.adapter;
  switch (row.provider) {
    case 'paystack': {
      const provider = createPaymentProvider({
        provider: dev ? 'dev' : 'paystack',
        environment: row.environment,
        secretKey: secrets.secretKey ?? null,
        publicKey: secrets.publicKey ?? null,
        appUrl: env.appUrl,
        appEnv: env.appEnv,
      });
      const r = await provider.testConnection();
      return {
        ok: r.ok && (dev || r.environmentDetected === row.environment),
        message: r.message,
        credentialInvalid: !r.ok && AUTH_FAILURE.test(r.message),
        details: { environmentDetected: r.environmentDetected },
      };
    }
    case 'termii': {
      const provider = createSmsProvider({
        adapter: dev ? 'dev' : 'termii',
        nodeEnv: env.nodeEnv,
        dev: { senderId: str(settings, 'senderId', 'SimplexD') },
        termii: dev
          ? undefined
          : {
              apiKey: secrets.apiKey ?? '',
              baseUrl: str(settings, 'baseUrl', 'https://v3.api.termii.com'),
              senderId: str(settings, 'senderId'),
              environment: row.environment,
              webhookSecret: secrets.webhookSecret ?? null,
            },
      });
      const r = await provider.testConnection();
      return {
        ok: r.ok,
        message: r.message,
        credentialInvalid: !r.ok && AUTH_FAILURE.test(r.message),
        details: { balance: r.balance ?? null, senderIdApproval: r.senderIdApproval ?? null },
      };
    }
    case 'smtp': {
      const username = str(settings, 'username') || null;
      const provider = createMailProvider({
        adapter: dev ? 'dev' : 'smtp',
        nodeEnv: env.nodeEnv,
        smtp: dev
          ? undefined
          : {
              host: str(settings, 'host'),
              port: num(settings, 'port', 587),
              security: str(settings, 'security') === 'implicit-tls' ? 'implicit-tls' : 'starttls',
              username,
              password: username ? (secrets.password ?? null) : null,
              from: { email: str(settings, 'fromEmail', 'no-reply@localhost'), name: str(settings, 'fromName', 'SimplexD') },
              replyTo: str(settings, 'replyTo') ? { email: str(settings, 'replyTo') } : null,
              allowedHosts: (process.env.SMTP_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
              allowPrivate: env.nodeEnv !== 'production' && env.appEnv !== 'production',
              approvedSenderDomains: list(settings, 'approvedSenderDomains'),
            },
      });
      const r = await provider.verifyConnection();
      return {
        ok: r.ok,
        message: r.message,
        credentialInvalid: !r.ok && r.errorCode === 'auth',
        details: { tls: r.tls, latencyMs: r.latencyMs, errorCode: r.errorCode ?? null },
      };
    }
    case 'google_workspace': {
      if (dev) {
        createCalendarProvider({ appEnv: env.appEnv, adapter: 'dev', redirectUri: env.appUrl });
        return { ok: true, message: 'Development calendar adapter (simulated; not Google)', credentialInvalid: false, details: {} };
      }
      const ok = str(settings, 'clientId').endsWith('.apps.googleusercontent.com') && Boolean(secrets.clientSecret);
      return {
        ok,
        message: ok
          ? 'OAuth client is well-formed; organiser grant health is tracked on calendar_connections'
          : 'OAuth client ID or secret is missing/malformed',
        credentialInvalid: !ok,
        details: {},
      };
    }
    case 'storage': {
      const provider = createStorageProvider(
        dev
          ? {
              appEnv: env.appEnv,
              provider: 'local-dev',
              localDev: {
                root: str(settings, 'devRoot', './uploads-dev'),
                appUrl: env.appUrl,
                signingSecret: process.env.DEV_STORAGE_SIGNING_SECRET || process.env.AUTH_SECRET || '',
              },
            }
          : {
              appEnv: env.appEnv,
              provider: 's3',
              s3: {
                region: str(settings, 'region', 'us-east-1'),
                endpoint: str(settings, 'endpoint') || null,
                forcePathStyle: bool(settings, 'forcePathStyle'),
                credentials:
                  secrets.accessKeyId && secrets.secretAccessKey
                    ? { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey }
                    : null,
                buckets: {
                  private: str(settings, 'bucketPrivate', 'simplexd-private'),
                  quarantine: str(settings, 'bucketQuarantine', 'simplexd-quarantine'),
                  derivatives: str(settings, 'bucketDerivatives') || null,
                },
              },
            },
      );
      await provider.headObject({ bucket: 'private', key: 'healthchecks/integration-probe.txt' });
      return { ok: true, message: 'Private bucket reachable', credentialInvalid: false, details: {} };
    }
    case 'scanner': {
      const scanner = createMalwareScanner({
        appEnv: env.appEnv,
        scanner: dev ? 'dev' : 'clamav',
        clamav: dev
          ? undefined
          : { host: str(settings, 'host', '127.0.0.1'), port: num(settings, 'port', 3310), timeoutMs: num(settings, 'timeoutMs', 60000) },
      });
      const ping = await scanner.ping();
      return {
        ok: ping.ok,
        message: ping.ok ? `Scanner responded (${ping.version ?? 'version unknown'})` : 'Scanner did not respond to PING',
        credentialInvalid: false,
        details: { version: ping.version },
      };
    }
    case 'maps': {
      const light = str(settings, 'styleUrlLight');
      const dark = str(settings, 'styleUrlDark') || undefined;
      if (!dev) {
        assertLicensedProvider(light, 'Style URL (light)');
        if (dark) assertLicensedProvider(dark, 'Style URL (dark)');
      }
      const config = resolveMapConfig(
        { NEXT_PUBLIC_MAP_STYLE_URL: light, NEXT_PUBLIC_MAP_STYLE_URL_DARK: dark },
        { appEnv: dev ? 'development' : env.appEnv },
      );
      return {
        ok: config.configured,
        message: config.configured ? 'Style URLs accepted' : 'Style URL is missing',
        credentialInvalid: false,
        details: { warnings: config.warnings },
      };
    }
    default:
      return { ok: true, message: `no health check defined for ${row.provider}`, credentialInvalid: false, details: {} };
  }
}

export interface HealthCheckSummary {
  checked: number;
  degraded: number;
  recovered: number;
}

/** Exported for tests and for ad-hoc runs; the job handler wraps it. */
export async function runIntegrationHealthCheck(
  db: Parameters<typeof withActor>[0],
  options: { keyring?: Keyring; appEnv?: string; nodeEnv?: string; appUrl?: string; timeoutMs?: number } = {},
): Promise<HealthCheckSummary> {
  const keyring = options.keyring ?? keyringFromEnv();
  const env = {
    appEnv: options.appEnv ?? process.env.APP_ENV ?? 'development',
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV ?? 'development',
    appUrl: (options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  };
  const summary: HealthCheckSummary = { checked: 0, degraded: 0, recovered: 0 };
  const active = await withActor(db, systemContext('integrations-health'), (tx) =>
    tx.select().from(schema.integrationConfigs).where(eq(schema.integrationConfigs.isActive, true)),
  );
  for (const row of active) {
    await withActor(db, systemContext('integrations-health'), async (tx) => {
      const { secrets, problems } = await decryptRow(tx, row, keyring);
      let outcome: Outcome;
      if (problems.length > 0) {
        outcome = { ok: false, message: `Secrets unavailable: ${problems.join('; ')}`, credentialInvalid: true, details: { problems } };
      } else {
        try {
          outcome = await withTimeout(checkRow(row, secrets, env), options.timeoutMs ?? 20_000);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown error';
          outcome = { ok: false, message, credentialInvalid: AUTH_FAILURE.test(message), details: {} };
        }
      }
      const values = Object.values(secrets);
      const message = scrub(outcome.message, values);
      const now = new Date();
      const nextStatus = outcome.ok ? 'connected' : outcome.credentialInvalid ? 'expired' : 'degraded';
      const transitioned = row.status !== nextStatus;
      await tx
        .update(schema.integrationConfigs)
        .set({
          status: nextStatus,
          lastCheckAt: now,
          lastCheckOk: outcome.ok,
          lastCheckMessage: message,
          lastSuccessAt: outcome.ok ? now : row.lastSuccessAt,
          updatedAt: now,
        })
        .where(eq(schema.integrationConfigs.id, row.id));
      await tx.insert(schema.integrationLogs).values({
        provider: row.provider,
        environment: row.environment,
        level: outcome.ok ? 'info' : 'warn',
        event: 'health.check',
        messageSanitized: message,
        metadataSanitized: {
          version: row.version,
          ok: outcome.ok,
          from: row.status,
          to: nextStatus,
          details: JSON.parse(scrub(JSON.stringify(outcome.details), values)),
        },
      });
      summary.checked += 1;
      if (transitioned && !outcome.ok) {
        summary.degraded += 1;
        await appendOutbox(tx, {
          eventType: 'integration.degraded',
          aggregateType: 'integration_config',
          aggregateId: row.id,
          payload: {
            provider: row.provider,
            environment: row.environment,
            version: row.version,
            status: nextStatus,
            message,
          },
        });
      } else if (transitioned && outcome.ok) {
        summary.recovered += 1;
      }
    });
  }
  return summary;
}

export function registerIntegrationHandlers(runner: JobRunner): void {
  runner.register('integrations.rewrap_secrets', async ({ db, log }) => {
    const keyring = keyringFromEnv();
    const report = await withActor(db, systemContext('integrations-rewrap'), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.secretReferences)
        .where(
          and(
            isNull(schema.secretReferences.retiredAt),
            ne(schema.secretReferences.masterKeyId, keyring.current.id),
          ),
        );
      let rewrapped = 0;
      const failed: Array<{ id: string; provider: string; fieldName: string }> = [];
      for (const row of rows) {
        try {
          const next = rewrapSecret(row, keyring);
          await tx
            .update(schema.secretReferences)
            .set({
              masterKeyId: next.masterKeyId,
              wrappedDek: next.wrappedDek,
              dekIv: next.dekIv,
              dekTag: next.dekTag,
              ciphertext: next.ciphertext,
              iv: next.iv,
              tag: next.tag,
            })
            .where(eq(schema.secretReferences.id, row.id));
          rewrapped += 1;
        } catch {
          failed.push({ id: row.id, provider: row.provider, fieldName: row.fieldName });
        }
      }
      await tx.insert(schema.integrationLogs).values({
        provider: 'secrets',
        environment: 'all',
        level: failed.length > 0 ? 'warn' : 'info',
        event: 'secrets.rewrapped',
        messageSanitized: `Re-wrapped ${rewrapped}/${rows.length} secrets under master key ${keyring.current.id}${
          failed.length > 0 ? `; ${failed.length} could not be opened (rotation window expired?)` : ''
        }`,
        metadataSanitized: { masterKeyId: keyring.current.id, rewrapped, failed },
      });
      return { scanned: rows.length, rewrapped, failed: failed.length };
    });
    log.info(report, 'integration secrets re-wrapped');
  });

  runner.register('integrations.health_check', async ({ db, log }) => {
    const summary = await runIntegrationHealthCheck(db);
    log.info(summary, 'integration health check complete');
  });
}

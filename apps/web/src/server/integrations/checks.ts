import { and, eq } from 'drizzle-orm';
import type { IntegrationEnvironment, IntegrationProvider } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { createCalendarProvider } from '@simplexd/integrations/google';
import { checkDnsRecords, createMailProvider, emailDomain } from '@simplexd/integrations/mail';
import { assertLicensedProvider, resolveMapConfig } from '@simplexd/integrations/maps';
import { createPaymentProvider, detectKeyEnvironment } from '@simplexd/integrations/payments';
import { createMalwareScanner } from '@simplexd/integrations/scanner';
import { createSmsProvider } from '@simplexd/integrations/sms';
import { createStorageProvider } from '@simplexd/integrations/storage';
import { isDevelopmentAdapter } from './catalog';

/**
 * Runs the real adapter check for a saved configuration version. Every
 * outcome is sanitised: secret values are scrubbed from messages before they
 * are stored or returned, and development adapters are labelled so a green
 * result can never be mistaken for a verified live credential.
 *
 * The worker's health check (apps/worker/src/handlers/integrations.ts) runs
 * the same checks; keep the two in step when adding a provider.
 */

export interface CheckInput {
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  adapter: string;
  settings: Record<string, unknown>;
  /** Decrypted secrets; used only for the duration of the check. */
  secrets: Record<string, string>;
  appEnv: string;
  nodeEnv: string;
  appUrl: string;
  /** Needed for Google (organiser grant lookup); optional elsewhere. */
  db?: DbExecutor;
  /** Operator allow-list for SMTP hosts (SMTP_ALLOWED_HOSTS). */
  smtpAllowedHosts?: string[];
  timeoutMs?: number;
}

export interface CheckOutcome {
  ok: boolean;
  message: string;
  mode: 'development' | 'real';
  environmentDetected: string | null;
  details: Record<string, unknown>;
  /** True when the failure means the credential itself is no longer valid (→ `expired`). */
  credentialInvalid: boolean;
}

/** Replaces every occurrence of a secret value (8+ chars) with a marker. */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const value of secrets) {
    if (!value || value.length < 8) continue;
    out = out.split(value).join('[redacted]');
  }
  return out;
}

function str(settings: Record<string, unknown>, key: string, fallback = ''): string {
  const v = settings[key];
  return typeof v === 'string' ? v : fallback;
}

function num(settings: Record<string, unknown>, key: string, fallback: number): number {
  const v = settings[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(settings: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = settings[key];
  return typeof v === 'boolean' ? v : fallback;
}

function list(settings: Record<string, unknown>, key: string): string[] {
  const v = settings[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

const AUTH_FAILURE =
  /invalid key|unauthori[sz]ed|401|403|invalid api key|invalid_grant|forbidden|auth/i;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runProviderCheck(input: CheckInput): Promise<CheckOutcome> {
  const dev = isDevelopmentAdapter(input.provider, input.adapter);
  const mode: CheckOutcome['mode'] = dev ? 'development' : 'real';
  const timeoutMs = input.timeoutMs ?? 20_000;
  const secretValues = Object.values(input.secrets);
  const finish = (partial: Omit<CheckOutcome, 'mode'>): CheckOutcome => ({
    ...partial,
    mode,
    message: scrubSecrets(
      dev ? `${partial.message} [development adapter]` : partial.message,
      secretValues,
    ),
    details: JSON.parse(scrubSecrets(JSON.stringify(partial.details ?? {}), secretValues)),
  });
  try {
    const outcome = await withTimeout(check(input, dev), timeoutMs, `${input.provider} check`);
    return finish(outcome);
  } catch (err) {
    const message = errorText(err);
    return finish({
      ok: false,
      message,
      environmentDetected: null,
      details: { error: message },
      credentialInvalid: AUTH_FAILURE.test(message),
    });
  }
}

async function check(input: CheckInput, dev: boolean): Promise<Omit<CheckOutcome, 'mode'>> {
  const { settings, secrets } = input;
  switch (input.provider) {
    case 'paystack': {
      const publicKey = secrets.publicKey ?? null;
      if (!dev && publicKey) {
        const pkEnv = publicKey.startsWith('pk_test_')
          ? 'test'
          : publicKey.startsWith('pk_live_')
            ? 'live'
            : 'unknown';
        if (pkEnv !== input.environment) {
          return {
            ok: false,
            message: `Paystack public key is a ${pkEnv} key but the integration is set to ${input.environment}`,
            environmentDetected: pkEnv,
            details: {},
            credentialInvalid: true,
          };
        }
      }
      const provider = createPaymentProvider({
        provider: dev ? 'dev' : 'paystack',
        environment: input.environment,
        secretKey: secrets.secretKey ?? null,
        publicKey,
        appUrl: input.appUrl,
        appEnv: input.appEnv,
      });
      const result = await provider.testConnection();
      const detected = dev ? input.environment : detectKeyEnvironment(secrets.secretKey);
      return {
        ok: result.ok && (dev || result.environmentDetected === input.environment),
        message: result.message,
        environmentDetected: result.environmentDetected ?? detected,
        details: { environmentDetected: result.environmentDetected },
        credentialInvalid: !result.ok && AUTH_FAILURE.test(result.message),
      };
    }
    case 'termii': {
      const provider = createSmsProvider({
        adapter: dev ? 'dev' : 'termii',
        nodeEnv: input.nodeEnv,
        dev: { senderId: str(settings, 'senderId', 'SimplexD') },
        termii: dev
          ? undefined
          : {
              apiKey: secrets.apiKey ?? '',
              baseUrl: str(settings, 'baseUrl', 'https://v3.api.termii.com'),
              senderId: str(settings, 'senderId'),
              environment: input.environment,
              webhookSecret: secrets.webhookSecret ?? null,
            },
      });
      const result = await provider.testConnection();
      return {
        ok: result.ok,
        message: result.message,
        environmentDetected: input.environment,
        details: {
          latencyMs: result.latencyMs,
          balance: result.balance ?? null,
          currency: result.currency ?? null,
          senderIdApproval: result.senderIdApproval ?? null,
        },
        credentialInvalid: !result.ok && AUTH_FAILURE.test(result.message),
      };
    }
    case 'smtp': {
      const fromEmail = str(settings, 'fromEmail', 'no-reply@localhost');
      const username = str(settings, 'username') || null;
      const provider = createMailProvider({
        adapter: dev ? 'dev' : 'smtp',
        nodeEnv: input.nodeEnv,
        smtp: dev
          ? undefined
          : {
              host: str(settings, 'host'),
              port: num(settings, 'port', 587),
              security:
                str(settings, 'security', 'starttls') === 'implicit-tls'
                  ? 'implicit-tls'
                  : 'starttls',
              username,
              password: username ? (secrets.password ?? null) : null,
              from: { email: fromEmail, name: str(settings, 'fromName', 'SimplexD') },
              replyTo: str(settings, 'replyTo') ? { email: str(settings, 'replyTo') } : null,
              allowedHosts: input.smtpAllowedHosts ?? [],
              allowPrivate: input.nodeEnv !== 'production' && input.appEnv !== 'production',
              approvedSenderDomains: list(settings, 'approvedSenderDomains'),
            },
      });
      const result = await provider.verifyConnection();
      const details: Record<string, unknown> = {
        tls: result.tls,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode ?? null,
      };
      if (!dev) {
        const domain = emailDomain(fromEmail);
        if (domain) details.dns = await checkDnsRecords(domain, { timeoutMs: 4000 });
      }
      return {
        ok: result.ok,
        message: result.message,
        environmentDetected: input.environment,
        details,
        credentialInvalid: !result.ok && result.errorCode === 'auth',
      };
    }
    case 'google_workspace': {
      if (dev) {
        createCalendarProvider({ appEnv: input.appEnv, adapter: 'dev', redirectUri: input.appUrl });
        return {
          ok: true,
          message: 'Development calendar adapter (simulated; not Google)',
          environmentDetected: input.environment,
          details: { organizerGrant: 'simulated' },
          credentialInvalid: false,
        };
      }
      const clientId = str(settings, 'clientId');
      if (!clientId.endsWith('.apps.googleusercontent.com')) {
        return {
          ok: false,
          message: 'OAuth client ID must end with .apps.googleusercontent.com',
          environmentDetected: null,
          details: {},
          credentialInvalid: true,
        };
      }
      if (!secrets.clientSecret) {
        return {
          ok: false,
          message: 'OAuth client secret is not set',
          environmentDetected: null,
          details: {},
          credentialInvalid: true,
        };
      }
      // The client itself can only be exercised through an organiser grant.
      let grant: Record<string, unknown> = { status: 'not_connected' };
      if (input.db) {
        const rows = await input.db
          .select({
            status: schema.calendarConnections.status,
            accountEmail: schema.calendarConnections.accountEmail,
            lastCheckOk: schema.calendarConnections.lastCheckOk,
            lastCheckedAt: schema.calendarConnections.lastCheckedAt,
          })
          .from(schema.calendarConnections)
          .where(
            and(
              eq(schema.calendarConnections.provider, 'google'),
              eq(schema.calendarConnections.environment, input.environment),
            ),
          );
        const connected = rows.find((r) => r.status === 'connected') ?? rows[0];
        if (connected) {
          grant = {
            status: connected.status,
            accountEmail: connected.accountEmail,
            lastCheckOk: connected.lastCheckOk,
            lastCheckedAt: connected.lastCheckedAt?.toISOString() ?? null,
          };
        }
      }
      const grantStatus = String(grant.status);
      return {
        ok: true,
        message:
          grantStatus === 'connected'
            ? `OAuth client is well-formed; organiser grant connected${grant.accountEmail ? ` as ${String(grant.accountEmail)}` : ''}`
            : 'OAuth client is well-formed. No organiser is connected yet: the calendar cannot be used until an organiser completes the OAuth grant.',
        environmentDetected: input.environment,
        details: { organizerGrant: grant },
        credentialInvalid: false,
      };
    }
    case 'storage': {
      const provider = createStorageProvider(
        dev
          ? {
              appEnv: input.appEnv,
              provider: 'local-dev',
              localDev: {
                root: str(settings, 'devRoot', './uploads-dev'),
                appUrl: input.appUrl,
                signingSecret:
                  process.env.DEV_STORAGE_SIGNING_SECRET || process.env.AUTH_SECRET || '',
              },
            }
          : {
              appEnv: input.appEnv,
              provider: 's3',
              signedUrlTtlSeconds: num(settings, 'signedUrlTtlSeconds', 300),
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
      const probeKey = 'healthchecks/integration-probe.txt';
      const head = await provider.headObject({ bucket: 'private', key: probeKey });
      return {
        ok: true,
        message: dev
          ? 'Local development storage is reachable'
          : `Private bucket reachable (probe object ${head ? 'present' : 'absent, which is fine'})`,
        environmentDetected: input.environment,
        details: { probeFound: Boolean(head) },
        credentialInvalid: false,
      };
    }
    case 'scanner': {
      const scanner = createMalwareScanner({
        appEnv: input.appEnv,
        scanner: dev ? 'dev' : 'clamav',
        clamav: dev
          ? undefined
          : {
              host: str(settings, 'host', '127.0.0.1'),
              port: num(settings, 'port', 3310),
              timeoutMs: num(settings, 'timeoutMs', 60000),
            },
      });
      const ping = await scanner.ping();
      return {
        ok: ping.ok,
        message: ping.ok
          ? `Scanner responded (${ping.version ?? 'version unknown'})`
          : 'Scanner did not respond to PING',
        environmentDetected: input.environment,
        details: { version: ping.version },
        credentialInvalid: false,
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
        {
          NEXT_PUBLIC_MAP_STYLE_URL: light,
          NEXT_PUBLIC_MAP_STYLE_URL_DARK: dark,
          NEXT_PUBLIC_MAP_ATTRIBUTION: str(settings, 'attribution') || undefined,
        },
        { appEnv: dev ? 'development' : input.appEnv },
      );
      return {
        ok: config.configured,
        message: config.configured
          ? `Style URLs accepted (${config.provider ?? 'unknown provider'}); tile delivery is verified in the browser`
          : 'Style URL is missing',
        environmentDetected: input.environment,
        details: {
          provider: config.provider,
          tileHosts: config.tileHosts,
          warnings: config.warnings,
        },
        credentialInvalid: false,
      };
    }
  }
}

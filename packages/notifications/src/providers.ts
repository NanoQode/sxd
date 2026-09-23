import { devAdapterAllowed, loadIntegrationConfig } from '@simplexd/integrations/config';
import {
  DevMailProvider,
  createMailProvider,
  smtpSettingsSchema,
  type MailProvider,
} from '@simplexd/integrations/mail';
import {
  DevSmsProvider,
  createSmsProvider,
  termiiSettingsSchema,
  type SmsProvider,
  type TermiiSettings,
} from '@simplexd/integrations/sms';
import type { PipelineEnv } from './env';
import type { Db } from './types';

/**
 * Provider resolution per attempt. The active `integration_configs` row for
 * the current environment decides which adapter sends; a labelled development
 * adapter is used only when no real configuration is active and APP_ENV is
 * not production. Production without an active configuration yields
 * `provider_not_configured`, which the pipeline records on the attempt and
 * surfaces in the delivery log instead of silently mocking the send.
 */

export const PROVIDER_NOT_CONFIGURED = 'provider_not_configured';

export interface ResolvedMailProvider {
  provider: MailProvider | null;
  /** `smtp`, `dev` or `none`. */
  adapter: 'smtp' | 'dev' | 'none';
  environment: 'test' | 'live';
  configId: string | null;
  from: { email: string; name: string };
  replyTo: { email: string } | null;
  reason: string | null;
}

export interface ResolvedSmsProvider {
  provider: SmsProvider | null;
  adapter: 'termii' | 'dev' | 'none';
  environment: 'test' | 'live';
  configId: string | null;
  senderId: string;
  settings: TermiiSettings | null;
  webhookSecret: string | null;
  reason: string | null;
}

let devMail: DevMailProvider | null = null;
let devSms: DevSmsProvider | null = null;

/** Process-wide development mail adapter (in-memory outbox) for tests and the dev UI. */
export function getDevMailProvider(nodeEnv?: string): DevMailProvider {
  devMail ??= new DevMailProvider({ nodeEnv: nodeEnv ?? process.env.NODE_ENV ?? 'development' });
  return devMail;
}

export function getDevSmsProvider(nodeEnv?: string): DevSmsProvider {
  devSms ??= new DevSmsProvider({ nodeEnv: nodeEnv ?? process.env.NODE_ENV ?? 'development' });
  return devSms;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function integrationEnvironment(env: PipelineEnv): 'test' | 'live' {
  return env.production ? 'live' : 'test';
}

export async function resolveMailProvider(db: Db, env: PipelineEnv): Promise<ResolvedMailProvider> {
  const environment = integrationEnvironment(env);
  const defaultFrom = { email: 'no-reply@localhost', name: `${env.brandName} (development)` };
  if (env.options.providers && 'mail' in env.options.providers) {
    const injected = env.options.providers.mail ?? null;
    return {
      provider: injected,
      adapter: injected ? (injected.id === 'dev' ? 'dev' : 'smtp') : 'none',
      environment,
      configId: null,
      from: defaultFrom,
      replyTo: null,
      reason: injected ? null : PROVIDER_NOT_CONFIGURED,
    };
  }
  let config: Awaited<ReturnType<typeof loadIntegrationConfig>> = null;
  try {
    config = await loadIntegrationConfig(db, 'smtp', {
      environment,
      appEnv: env.appEnv,
      ...(env.options.keyring ? { keyring: env.options.keyring } : {}),
    });
  } catch (err) {
    return {
      provider: null,
      adapter: 'none',
      environment,
      configId: null,
      from: defaultFrom,
      replyTo: null,
      reason: `smtp configuration unusable: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
  if (config && config.enabled && config.adapter !== 'dev') {
    const parsed = smtpSettingsSchema.safeParse(config.settings);
    if (!parsed.success) {
      return {
        provider: null,
        adapter: 'none',
        environment,
        configId: config.id,
        from: defaultFrom,
        replyTo: null,
        reason: 'smtp settings invalid; re-save the configuration in Admin → Integrations',
      };
    }
    const s = parsed.data;
    const password = config.secrets['password'] ?? null;
    const from = { email: s.fromEmail, name: s.fromName };
    try {
      const provider = createMailProvider({
        adapter: 'smtp',
        nodeEnv: env.nodeEnv,
        smtp: {
          host: s.host,
          port: s.port,
          security: s.security,
          username: s.username,
          password: s.username ? password : null,
          from,
          replyTo: s.replyTo ? { email: s.replyTo } : null,
          allowedHosts: csv(process.env.SMTP_ALLOWED_HOSTS),
          allowPrivate: env.nodeEnv !== 'production' && env.appEnv !== 'production',
          approvedSenderDomains: s.approvedSenderDomains,
        },
      });
      return {
        provider,
        adapter: 'smtp',
        environment,
        configId: config.id,
        from,
        replyTo: s.replyTo ? { email: s.replyTo } : null,
        reason: null,
      };
    } catch (err) {
      return {
        provider: null,
        adapter: 'none',
        environment,
        configId: config.id,
        from,
        replyTo: null,
        reason: `smtp adapter unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }
  if (devAdapterAllowed(env.appEnv) && env.nodeEnv !== 'production') {
    return {
      provider: getDevMailProvider(env.nodeEnv),
      adapter: 'dev',
      environment,
      configId: config?.id ?? null,
      from: defaultFrom,
      replyTo: null,
      reason: null,
    };
  }
  return {
    provider: null,
    adapter: 'none',
    environment,
    configId: config?.id ?? null,
    from: defaultFrom,
    replyTo: null,
    reason: PROVIDER_NOT_CONFIGURED,
  };
}

export async function resolveSmsProvider(db: Db, env: PipelineEnv): Promise<ResolvedSmsProvider> {
  const environment = integrationEnvironment(env);
  if (env.options.providers && 'sms' in env.options.providers) {
    const injected = env.options.providers.sms ?? null;
    return {
      provider: injected,
      adapter: injected ? (injected.id === 'dev' ? 'dev' : 'termii') : 'none',
      environment,
      configId: null,
      senderId: injected?.describe().senderId ?? 'SimplexD',
      settings: null,
      webhookSecret: null,
      reason: injected ? null : PROVIDER_NOT_CONFIGURED,
    };
  }
  let config: Awaited<ReturnType<typeof loadIntegrationConfig>> = null;
  try {
    config = await loadIntegrationConfig(db, 'termii', {
      environment,
      appEnv: env.appEnv,
      ...(env.options.keyring ? { keyring: env.options.keyring } : {}),
    });
  } catch (err) {
    return {
      provider: null,
      adapter: 'none',
      environment,
      configId: null,
      senderId: 'SimplexD',
      settings: null,
      webhookSecret: null,
      reason: `termii configuration unusable: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
  if (config && config.enabled && config.adapter !== 'dev') {
    const parsed = termiiSettingsSchema.safeParse(config.settings);
    if (!parsed.success) {
      return {
        provider: null,
        adapter: 'none',
        environment,
        configId: config.id,
        senderId: 'SimplexD',
        settings: null,
        webhookSecret: null,
        reason: 'termii settings invalid; re-save the configuration in Admin → Integrations',
      };
    }
    const s = parsed.data;
    const apiKey = config.secrets['apiKey'] ?? '';
    const webhookSecret = config.secrets['webhookSecret'] ?? null;
    try {
      const allowedHosts = csv(process.env.TERMII_ALLOWED_HOSTS);
      const provider = createSmsProvider({
        adapter: 'termii',
        nodeEnv: env.nodeEnv,
        termii: {
          apiKey,
          baseUrl: s.baseUrl,
          senderId: s.senderId,
          environment: s.environment,
          webhookSecret,
          ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
        },
      });
      return {
        provider,
        adapter: 'termii',
        environment,
        configId: config.id,
        senderId: s.senderId,
        settings: s,
        webhookSecret,
        reason: null,
      };
    } catch (err) {
      return {
        provider: null,
        adapter: 'none',
        environment,
        configId: config.id,
        senderId: s.senderId,
        settings: s,
        webhookSecret,
        reason: `termii adapter unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }
  if (devAdapterAllowed(env.appEnv) && env.nodeEnv !== 'production') {
    const provider = getDevSmsProvider(env.nodeEnv);
    return {
      provider,
      adapter: 'dev',
      environment,
      configId: config?.id ?? null,
      senderId: provider.describe().senderId ?? 'SimplexD',
      settings: null,
      webhookSecret: null,
      reason: null,
    };
  }
  return {
    provider: null,
    adapter: 'none',
    environment,
    configId: config?.id ?? null,
    senderId: 'SimplexD',
    settings: null,
    webhookSecret: null,
    reason: PROVIDER_NOT_CONFIGURED,
  };
}

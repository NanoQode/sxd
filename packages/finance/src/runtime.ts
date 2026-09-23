import type { Database } from '@simplexd/db';
import {
  defaultIntegrationEnvironment,
  devAdapterAllowed,
  loadIntegrationConfig,
  type IntegrationEnvironmentKey,
} from '@simplexd/integrations/config';
import {
  DevPaymentProvider,
  createPaymentProvider,
  type PaymentEnvironment,
  type PaymentProvider,
} from '@simplexd/integrations/payments';
import { ApiError } from '@simplexd/contracts';

/**
 * Process-wide dependencies for the finance orchestration: the database
 * handle, the public app origin, the environment and the provider resolver.
 * Web routes and worker handlers build one runtime each; tests inject a
 * resolver that returns a shared development adapter.
 */

export type ProviderKind = 'paystack' | 'dev';

export interface ResolvedProvider {
  kind: ProviderKind;
  environment: PaymentEnvironment;
  provider: PaymentProvider;
  /** Webhook signature secret (Paystack: the secret key unless a webhook secret is configured). */
  webhookSecretConfigured: boolean;
}

export type ProviderResolver = (
  environment: IntegrationEnvironmentKey,
) => Promise<ResolvedProvider | null>;

export interface FinanceRuntime {
  db: Database;
  appUrl: string;
  appEnv: string;
  /** Environment new payment attempts are created in. */
  defaultEnvironment: IntegrationEnvironmentKey;
  resolveProvider: ProviderResolver;
  now: () => Date;
}

export interface FinanceRuntimeOptions {
  db: Database;
  appUrl?: string;
  appEnv?: string;
  defaultEnvironment?: IntegrationEnvironmentKey;
  resolveProvider?: ProviderResolver;
  now?: () => Date;
}

const devProviders = globalThis as unknown as {
  __simplexdDevPaymentProvider?: DevPaymentProvider;
};

/**
 * The development adapter keeps its simulated transactions in memory, so one
 * instance per process is shared between the checkout page, the callback and
 * the webhook route. It is never constructed in production.
 */
export function getDevPaymentProvider(appUrl: string, appEnv?: string): DevPaymentProvider {
  if (!devProviders.__simplexdDevPaymentProvider) {
    devProviders.__simplexdDevPaymentProvider = new DevPaymentProvider({
      appUrl,
      environment: 'test',
      ...(appEnv ? { appEnv } : {}),
    });
  }
  return devProviders.__simplexdDevPaymentProvider;
}

/**
 * Default resolver: the active Paystack configuration for the environment
 * (secrets decrypted at call time, never logged), otherwise the labelled
 * development adapter when APP_ENV allows it, otherwise null.
 */
export function defaultProviderResolver(options: {
  db: Database;
  appUrl: string;
  appEnv: string;
}): ProviderResolver {
  return async (environment) => {
    const config = await loadIntegrationConfig(options.db, 'paystack', { environment });
    if (config && config.enabled && config.adapter !== 'dev' && config.secrets['secretKey']) {
      const provider = createPaymentProvider({
        provider: 'paystack',
        environment,
        secretKey: config.secrets['secretKey'],
        publicKey: config.secrets['publicKey'] ?? null,
        appUrl: options.appUrl,
        appEnv: options.appEnv,
      });
      return { kind: 'paystack', environment, provider, webhookSecretConfigured: true };
    }
    if (environment === 'test' && devAdapterAllowed(options.appEnv)) {
      return {
        kind: 'dev',
        environment: 'test',
        provider: getDevPaymentProvider(options.appUrl, options.appEnv),
        webhookSecretConfigured: true,
      };
    }
    return null;
  };
}

export function createFinanceRuntime(options: FinanceRuntimeOptions): FinanceRuntime {
  const appUrl = options.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000';
  const appEnv = options.appEnv ?? process.env.APP_ENV ?? 'development';
  const defaultEnvironment = options.defaultEnvironment ?? defaultIntegrationEnvironment(appEnv);
  return {
    db: options.db,
    appUrl,
    appEnv,
    defaultEnvironment,
    resolveProvider:
      options.resolveProvider ?? defaultProviderResolver({ db: options.db, appUrl, appEnv }),
    now: options.now ?? (() => new Date()),
  };
}

/** Resolves the provider or throws the customer-safe `provider_not_configured` error. */
export async function requireProvider(
  rt: FinanceRuntime,
  environment: IntegrationEnvironmentKey,
): Promise<ResolvedProvider> {
  const resolved = await rt.resolveProvider(environment);
  if (!resolved) {
    throw new ApiError(
      'provider_not_configured',
      'online payments are not available yet; contact support or pay by bank transfer',
      { details: { environment } },
    );
  }
  return resolved;
}

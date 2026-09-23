import { DevPaymentProvider } from './dev';
import { ProviderError } from './errors';
import { PaystackPaymentProvider, type FetchLike } from './paystack';
import type { PaymentEnvironment, PaymentProvider, PaymentProviderId } from './types';
import { detectKeyEnvironment } from './validation';

export interface PaymentProviderConfig {
  provider: PaymentProviderId;
  environment: PaymentEnvironment;
  /** Decrypted at call time from the integration settings; never logged. */
  secretKey?: string | null;
  publicKey?: string | null;
  /** Public origin of the app, used for the dev checkout page. */
  appUrl: string;
  fetchImpl?: FetchLike;
  /** Defaults to process.env.APP_ENV. */
  appEnv?: string;
}

/**
 * Builds the configured provider. The dev adapter is refused in production so
 * a missing Paystack configuration can never silently fall back to a mock.
 */
export function createPaymentProvider(config: PaymentProviderConfig): PaymentProvider {
  const appEnv = config.appEnv ?? process.env.APP_ENV;
  if (config.provider === 'dev') {
    if (appEnv === 'production') {
      throw new Error(
        'payment provider "dev" is a development adapter and is refused when APP_ENV=production; configure Paystack in Admin → Integrations',
      );
    }
    return new DevPaymentProvider({
      appUrl: config.appUrl,
      environment: config.environment,
      appEnv,
    });
  }
  if (config.provider === 'paystack') {
    const secretKey = config.secretKey?.trim();
    if (!secretKey) {
      throw new ProviderError(
        'auth',
        'Paystack secret key is not configured; save it in Admin → Integrations → Payments and run the connection test',
      );
    }
    const detected = detectKeyEnvironment(secretKey);
    if (detected !== config.environment) {
      throw new ProviderError(
        'invalid_request',
        `Paystack secret key is a ${detected} key but the integration is set to ${config.environment}`,
      );
    }
    return new PaystackPaymentProvider({
      secretKey,
      publicKey: config.publicKey ?? null,
      environment: config.environment,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
  }
  throw new Error(`unsupported payment provider ${String(config.provider)}`);
}

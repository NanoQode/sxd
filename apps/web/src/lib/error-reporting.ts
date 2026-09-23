import 'server-only';
import {
  createErrorReporter,
  type ErrorContext,
  type ErrorReporter,
} from '@simplexd/integrations/observability';
import { logger } from './logger';

/**
 * Server-side error tracking for the web app. Enabled only when SENTRY_DSN is
 * set; see packages/integrations/src/observability/error-reporting.ts for
 * exactly what an event contains (and what it never contains). Reads
 * process.env directly so the instrumentation hook can run before `env()`
 * has validated the full configuration.
 */

const globalRef = globalThis as unknown as { __sxErrorReporter?: ErrorReporter };

export function errorReporter(): ErrorReporter {
  if (globalRef.__sxErrorReporter) return globalRef.__sxErrorReporter;
  globalRef.__sxErrorReporter = createErrorReporter({
    dsn: process.env.SENTRY_DSN,
    release: process.env.APP_VERSION ?? 'dev',
    environment: process.env.APP_ENV ?? 'development',
    source: 'web',
    onWarning: (message, detail) => logger().warn(detail, message),
  });
  return globalRef.__sxErrorReporter;
}

/** Fire-and-forget: never throws, never delays the response. */
export function reportServerError(error: unknown, context: ErrorContext = {}): Promise<void> {
  return errorReporter()
    .capture(error, context)
    .then(
      () => undefined,
      () => undefined,
    );
}

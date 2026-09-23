import 'server-only';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from '@simplexd/integrations/observability';
import pino, { type DestinationStream, type Logger } from 'pino';

const globalRef = globalThis as unknown as { __sxLogger?: Logger };

/**
 * Structured JSON logger with the shared redaction paths (authorization and
 * cookie headers, passwords, secrets, tokens, API keys, OTPs, card numbers).
 * `destination` is for tests; production logs go to stdout.
 */
export function createWebLogger(destination?: DestinationStream): Logger {
  const appEnv = process.env.APP_ENV ?? 'development';
  const pretty = !destination && (process.env.LOG_PRETTY === 'true' || appEnv === 'development');
  const options: pino.LoggerOptions = {
    name: 'web',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

export function logger(): Logger {
  if (globalRef.__sxLogger) return globalRef.__sxLogger;
  globalRef.__sxLogger = createWebLogger();
  return globalRef.__sxLogger;
}

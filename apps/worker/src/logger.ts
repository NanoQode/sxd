import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from '@simplexd/integrations/observability';
import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Structured JSON logger with the shared redaction paths (authorization and
 * cookie headers, passwords, secrets, tokens, API keys, OTPs, card numbers,
 * including inside job payloads). `destination` is for tests.
 */
export function createLogger(name: string, destination?: DestinationStream): Logger {
  const pretty =
    !destination &&
    (process.env.LOG_PRETTY === 'true' || (process.env.APP_ENV ?? 'development') === 'development');
  const options: pino.LoggerOptions = {
    name,
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

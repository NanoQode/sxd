import 'server-only';
import pino, { type Logger } from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.apiKey',
  '*.api_key',
  '*.otp',
  '*.cardNumber',
];

const globalRef = globalThis as unknown as { __sxLogger?: Logger };

export function logger(): Logger {
  if (globalRef.__sxLogger) return globalRef.__sxLogger;
  const appEnv = process.env.APP_ENV ?? 'development';
  const pretty = process.env.LOG_PRETTY === 'true' || appEnv === 'development';
  globalRef.__sxLogger = pino({
    name: 'web',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: redactPaths, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  });
  return globalRef.__sxLogger;
}

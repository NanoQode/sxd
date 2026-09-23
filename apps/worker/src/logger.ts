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
  'payload.password',
  'payload.otp',
];

export function createLogger(name: string): Logger {
  const pretty =
    process.env.LOG_PRETTY === 'true' || (process.env.APP_ENV ?? 'development') === 'development';
  return pino({
    name,
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
}

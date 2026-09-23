/**
 * Log redaction shared by the web and worker pino loggers (brief §19: logs
 * must not contain tokens, identity files, raw payment secrets or private
 * message content). pino's redact paths are matched structurally, so the
 * sensitive keys are listed at the top level and one and two levels down
 * (`*` matches one path segment), plus the request/response header shapes.
 */

export const SENSITIVE_LOG_KEYS: readonly string[] = [
  'password',
  'newPassword',
  'currentPassword',
  'passphrase',
  'secret',
  'clientSecret',
  'secretKey',
  'privateKey',
  'webhookSecret',
  'signingSecret',
  'token',
  'refreshToken',
  'accessToken',
  'idToken',
  'sessionToken',
  'apiKey',
  'api_key',
  'otp',
  'cardNumber',
  'cvv',
  'authorization',
  'cookie',
];

const HEADER_KEYS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

function headerPath(prefix: string, key: string): string {
  return key.includes('-') ? `${prefix}["${key}"]` : `${prefix}.${key}`;
}

function buildPaths(): string[] {
  const paths = new Set<string>();
  for (const key of SENSITIVE_LOG_KEYS) {
    paths.add(key);
    paths.add(`*.${key}`);
    paths.add(`*.*.${key}`);
  }
  for (const prefix of ['headers', 'req.headers', 'res.headers', '*.headers', '*.*.headers']) {
    for (const key of HEADER_KEYS) paths.add(headerPath(prefix, key));
  }
  return [...paths];
}

/** pino `redact.paths` for every application logger. */
export const LOG_REDACT_PATHS: readonly string[] = buildPaths();

export const LOG_REDACT_CENSOR = '[redacted]';

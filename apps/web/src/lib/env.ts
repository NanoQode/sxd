import 'server-only';
import { z } from 'zod';

/**
 * Server environment, validated once at startup. Secrets never reach the
 * browser: only NEXT_PUBLIC_* values are exposed through `publicEnv`.
 */
const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_NAME: z.string().default('SimplexD'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  TRUSTED_ORIGINS: z.string().default(''),
  BUSINESS_TIME_ZONE: z.string().default('Africa/Lagos'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_SESSION_MAX_AGE: z.coerce.number().int().positive().default(604800),
  AUTH_REQUIRE_STAFF_MFA: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  SECRETS_MASTER_KEY: z.string().min(1),
  SECRETS_MASTER_KEY_ID: z.string().default('local-1'),
  SECRETS_PREVIOUS_MASTER_KEY: z.string().optional(),
  SECRETS_PREVIOUS_MASTER_KEY_ID: z.string().optional(),
  STORAGE_PROVIDER: z.enum(['s3', 'local-dev']).default('local-dev'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET_PRIVATE: z.string().default('simplexd-private'),
  S3_BUCKET_QUARANTINE: z.string().default('simplexd-quarantine'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MALWARE_SCANNER: z.enum(['clamav', 'dev']).default('dev'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  MAP_TILE_HOSTS: z.string().default(''),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  TERMII_API_KEY: z.string().optional(),
  TERMII_BASE_URL: z.string().optional(),
  TERMII_SENDER_ID: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURITY: z.enum(['implicit-tls', 'starttls', 'none']).optional(),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_ALLOWED_HOSTS: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('SimplexD'),
  MAIL_FROM_ADDRESS: z.string().default('no-reply@localhost'),
  MAIL_REPLY_TO: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_PATH: z.string().default('/api/v1/admin/integrations/google/callback'),
  SENTRY_DSN: z.string().optional(),
  HEALTH_TOKEN: z.string().optional(),
  ENABLE_DEMO_SEED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const value = parsed.data;
  if (value.APP_ENV === 'production') {
    const problems: string[] = [];
    if (value.STORAGE_PROVIDER === 'local-dev')
      problems.push('STORAGE_PROVIDER=local-dev is not allowed in production');
    if (value.MALWARE_SCANNER === 'dev')
      problems.push('MALWARE_SCANNER=dev is not allowed in production');
    if (value.SMTP_SECURITY === 'none')
      problems.push('SMTP_SECURITY=none is not allowed in production');
    if (!value.APP_URL.startsWith('https://'))
      problems.push('APP_URL must use https in production');
    if (value.ENABLE_DEMO_SEED) problems.push('ENABLE_DEMO_SEED must be false in production');
    if (problems.length > 0)
      throw new Error(`Production configuration refused: ${problems.join('; ')}`);
  }
  cached = value;
  return value;
}

export const isDevelopmentLike = (): boolean => {
  const e = env().APP_ENV;
  return e === 'development' || e === 'test';
};

export function trustedOrigins(): string[] {
  const e = env();
  return [
    e.APP_URL,
    ...e.TRUSTED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

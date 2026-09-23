/**
 * Test database configuration. Defaults match docker-compose.yml and the
 * local bootstrap documented in docs/operations/local-development.md.
 */
export const TEST_MIGRATION_DATABASE_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ??
  'postgres://simplexd_owner:simplexd_owner_local@127.0.0.1:5432/simplexd_test';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://simplexd_app:simplexd_app_local@127.0.0.1:5432/simplexd_test';

export function applyTestEnv(): void {
  process.env.APP_ENV = 'test';
  const mutable = process.env as Record<string, string | undefined>;
  mutable.NODE_ENV ??= 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = TEST_MIGRATION_DATABASE_URL;
  process.env.AUTH_SECRET ??= 'test-secret-test-secret-test-secret-test-secret';
  process.env.SECRETS_MASTER_KEY ??= 'dGVzdC1tYXN0ZXIta2V5LXRlc3QtbWFzdGVyLWtleS0zMg==';
  process.env.SECRETS_MASTER_KEY_ID ??= 'test-1';
  process.env.APP_URL ??= 'http://localhost:3000';
  process.env.STORAGE_PROVIDER ??= 'local-dev';
  process.env.MALWARE_SCANNER ??= 'dev';
  process.env.ENABLE_DEMO_SEED ??= 'true';
}

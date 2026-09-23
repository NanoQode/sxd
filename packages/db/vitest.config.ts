import { defineConfig } from 'vitest/config';

// Integration tests: they require TEST_DATABASE_URL (see .env.test.example) and
// run migrations against a disposable schema before the suite starts.
export default defineConfig({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/testing/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

import { defineConfig } from 'vitest/config';

// Integration tests run against the disposable test database (migrated by the
// shared global setup); pure unit tests live alongside as *.test.ts too.
export default defineConfig({
  test: {
    name: 'finance',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['../db/src/testing/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

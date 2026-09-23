import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'src/testing/server-only-stub.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'web-unit',
          environment: 'node',
          include: ['src/**/*.unit.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web-integration',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
          setupFiles: ['./src/testing/setup-env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

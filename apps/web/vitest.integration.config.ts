import { defineConfig } from 'vitest/config';
import { webResolve } from './vitest.shared';

export default defineConfig({
  resolve: webResolve,
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
});

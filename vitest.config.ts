import { defineConfig } from 'vitest/config';

// Root Vitest configuration. Each workspace package defines its own project
// (name, environment, setup) in its vitest.config.ts; this file only stitches
// them together so `pnpm test` runs everything and `--project <name>` selects one.
export default defineConfig({
  test: {
    projects: [
      'packages/domain',
      'packages/contracts',
      'packages/integrations',
      'packages/ui',
      'packages/db',
      'apps/web',
      'apps/worker',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/migrations/**'],
    },
  },
});

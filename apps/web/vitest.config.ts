import { defineConfig } from 'vitest/config';

// Running `vitest` inside apps/web runs both projects; the repository root
// lists the two project files directly so `--project web-unit` and
// `--project web-integration` work from the root too.
export default defineConfig({
  test: {
    projects: ['./vitest.unit.config.ts', './vitest.integration.config.ts'],
  },
});

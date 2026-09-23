import { defineConfig } from 'vitest/config';
import { webResolve } from './vitest.shared';

export default defineConfig({
  resolve: webResolve,
  test: {
    name: 'web-unit',
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
  },
});

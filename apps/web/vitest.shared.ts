import path from 'node:path';

/** Resolution shared by the web unit and integration test projects. */
export const webResolve = {
  alias: {
    '@': path.resolve(import.meta.dirname, 'src'),
    'server-only': path.resolve(import.meta.dirname, 'src/testing/server-only-stub.ts'),
  },
};

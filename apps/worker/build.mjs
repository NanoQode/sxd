import { build } from 'esbuild';

/**
 * Bundles the worker and the operational CLI commands into dist/. Workspace
 * packages (@simplexd/*) are inlined; third-party packages stay external and
 * are installed in the image with `pnpm deploy`.
 *
 * Outputs:
 *   dist/main.js               worker process
 *   dist/cli/migrate.js        apply migrations (owner role)
 *   dist/cli/seed.js           reference data + market import
 *   dist/cli/import-markets.js re-run the market import (--dry-run)
 *   dist/cli/bootstrap-admin.js first administrator setup link
 *   dist/cli/check-rls.js      verify the runtime role cannot bypass RLS
 */
await build({
  entryPoints: [
    { in: 'src/main.ts', out: 'main' },
    { in: '../../packages/db/src/cli/migrate.ts', out: 'cli/migrate' },
    { in: '../../packages/db/src/cli/seed.ts', out: 'cli/seed' },
    { in: '../../packages/db/src/cli/import-markets.ts', out: 'cli/import-markets' },
    { in: '../../packages/db/src/cli/bootstrap-admin.ts', out: 'cli/bootstrap-admin' },
    { in: '../../packages/db/src/cli/check-rls.ts', out: 'cli/check-rls' },
  ],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalize-node-modules',
      setup(b) {
        // Bare specifiers (no leading "." or "/") are third-party or node built-ins.
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@simplexd/')) return null;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

import { build } from 'esbuild';

/**
 * Bundles the worker into dist/main.js. Workspace packages (@simplexd/*) are
 * inlined; third-party packages stay external and are installed in the image.
 */
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
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

/**
 * Generates docs/api/openapi.json from the route registry files under
 * src/lib/api/registry. Each registry module calls registerRoute() at import
 * time. Run: pnpm openapi
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildOpenApiDocument } from '@simplexd/contracts';

const registryDir = path.resolve(import.meta.dirname, '../src/lib/api/registry');
const outFile = path.resolve(import.meta.dirname, '../../../docs/api/openapi.json');

const files = fs.existsSync(registryDir)
  ? fs
      .readdirSync(registryDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort()
  : [];

for (const file of files) {
  await import(pathToFileURL(path.join(registryDir, file)).href);
}

const version =
  process.env.APP_VERSION ??
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;
const doc = buildOpenApiDocument({
  title: 'SimplexD API',
  version,
  serverUrl: `${process.env.APP_URL ?? 'https://app.example.com'}/api/v1`,
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));
const pathCount = Object.keys((doc as { paths: Record<string, unknown> }).paths).length;
console.log(`Wrote ${outFile} (${files.length} registry modules, ${pathCount} paths)`);

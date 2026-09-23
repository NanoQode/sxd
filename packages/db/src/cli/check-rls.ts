import { getDb, closeDb } from '../client';
import { checkRuntimeRole } from '../runtime-checks';
import { loadEnv } from './_env';

loadEnv();

const report = await checkRuntimeRole(getDb());
console.log(JSON.stringify(report, null, 2));
await closeDb();
if (!report.rlsEnforced) {
  console.error(
    'Row-level security is NOT enforced for the runtime role. Use a dedicated non-superuser role without BYPASSRLS that does not own the tables (see docs/operations/deployment.md).',
  );
  process.exitCode = process.env.APP_ENV === 'production' ? 1 : 0;
}

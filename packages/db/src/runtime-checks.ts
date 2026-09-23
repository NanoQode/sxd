import { sql } from 'drizzle-orm';
import type { Database } from './client';

export interface RuntimeRoleReport {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsTables: boolean;
  rlsEnforced: boolean;
  warnings: string[];
}

/**
 * Verifies that the runtime database role cannot bypass row-level security.
 * Called at application and worker start-up; production refuses to start when
 * RLS would not be enforced.
 */
export async function checkRuntimeRole(db: Database): Promise<RuntimeRoleReport> {
  const res = await db.execute<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owns: string;
  }>(sql`
    select r.rolname, r.rolsuper, r.rolbypassrls,
      (select count(*)::text from pg_tables t where t.schemaname = 'public' and t.tableowner = r.rolname) as owns
    from pg_roles r where r.rolname = current_user
  `);
  const row = res.rows[0];
  if (!row) throw new Error('could not inspect current database role');
  const ownsTables = Number(row.owns) > 0;
  const warnings: string[] = [];
  if (row.rolsuper)
    warnings.push('runtime role is a superuser; row-level security is not enforced');
  if (row.rolbypassrls)
    warnings.push('runtime role has BYPASSRLS; row-level security is not enforced');
  if (ownsTables)
    warnings.push(
      'runtime role owns application tables; row-level security is not enforced for owners',
    );
  return {
    role: row.rolname,
    superuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    ownsTables,
    rlsEnforced: warnings.length === 0,
    warnings,
  };
}

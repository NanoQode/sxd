import 'server-only';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import type { PropertyDto } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { toPropertyDto } from '@/server/properties/dto';
import { requireAnyStaff, staffTx } from './context';

/**
 * Properties across organisations. The property service scopes staff to one
 * organisation per call, so the console reads the table directly under the
 * staff row-level security context when no organisation filter is set.
 */
export async function listAllProperties(
  identity: RequestIdentity,
  filters: { kind?: string; status: string; q?: string },
): Promise<{ items: PropertyDto[]; nextCursor: string | null }> {
  requireAnyStaff(identity, ['customers.read', 'projects.read_all']);
  const rows = await staffTx(identity, (tx) =>
    tx
      .select()
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.status, filters.status as never),
          filters.kind ? eq(schema.properties.kind, filters.kind as never) : undefined,
          filters.q ? or(ilike(schema.properties.name, `%${filters.q.replace(/[%_]/g, '')}%`)) : undefined,
        ),
      )
      .orderBy(desc(schema.properties.updatedAt))
      .limit(100),
  );
  return { items: rows.map(toPropertyDto), nextCursor: null };
}

/** Projects linked to a property. */
export async function propertyProjects(identity: RequestIdentity, propertyId: string) {
  requireAnyStaff(identity, ['customers.read', 'projects.read_all']);
  return staffTx(identity, (tx) =>
    tx
      .select({ id: schema.projects.id, name: schema.projects.name, status: schema.projects.status, kind: schema.projects.kind })
      .from(schema.projects)
      .where(eq(schema.projects.propertyId, propertyId))
      .orderBy(desc(schema.projects.updatedAt)),
  );
}

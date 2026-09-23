import 'server-only';
import { eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeAny, type ResourceRef } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Property authorisation. Customers manage their own organisation's assets
 * through `org.properties.manage`; staff act through `customers.manage` or
 * `projects.manage`. Reads accept `org.read`, `customers.read` and
 * `projects.read_all`. Row-level security (`app.can_access_property`) is the
 * second net: a property of another organisation is simply not visible, so
 * cross-organisation requests end as `not_found` before any policy runs.
 */

export type PropertyRow = typeof schema.properties.$inferSelect;

export function propertyRef(organizationId: string, id?: string): ResourceRef {
  return { type: 'property', id, organizationId };
}

export function assertPropertyRead(identity: RequestIdentity, ref: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [{ staff: 'customers.read' }, { staff: 'projects.read_all' }, { org: 'org.read' }],
      ref,
    ),
  );
}

export function assertPropertyManage(identity: RequestIdentity, ref: ResourceRef): void {
  assertAllowed(
    authorizeAny(
      identity.actor,
      [
        { staff: 'customers.manage' },
        { staff: 'projects.manage' },
        { org: 'org.properties.manage' },
      ],
      ref,
    ),
  );
}

/** Loads a property under the caller's row-level security context. */
export async function loadProperty(tx: DbExecutor, id: string): Promise<PropertyRow | null> {
  const rows = await tx.select().from(schema.properties).where(eq(schema.properties.id, id));
  return rows[0] ?? null;
}

/**
 * Loads a property the caller may read or manage. The SQL read proves
 * visibility; the policy check proves the permission. Both must pass.
 */
export async function requireProperty(
  tx: DbExecutor,
  identity: RequestIdentity,
  id: string,
  mode: 'read' | 'manage',
): Promise<PropertyRow> {
  const row = await loadProperty(tx, id);
  if (!row) throw new ApiError('not_found', 'property not found');
  const ref = propertyRef(row.organizationId, row.id);
  if (mode === 'manage') assertPropertyManage(identity, ref);
  else assertPropertyRead(identity, ref);
  return row;
}

/** Resolves the organisation a new property belongs to. */
export function resolveTargetOrganization(
  identity: RequestIdentity,
  requested: string | undefined,
): string {
  const isStaff = identity.actor.staffRoles.length > 0;
  const active = identity.ctx.organizationId;
  if (isStaff && !active) {
    if (!requested) {
      throw new ApiError('validation_failed', 'organizationId is required when acting as staff', {
        details: [{ path: 'organizationId', message: 'required' }],
      });
    }
    return requested;
  }
  if (!active) {
    throw new ApiError('forbidden', 'create or join an organisation before adding properties', {
      details: { code: 'no_organization', next: '/onboarding' },
    });
  }
  if (requested && requested !== active) {
    throw new ApiError('forbidden', 'properties can only be created in the active organisation');
  }
  return active;
}

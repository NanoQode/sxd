import 'server-only';
import { asc, inArray, sql } from 'drizzle-orm';
import { schema, type Transaction } from '@simplexd/db';
import { AuthorizationError, type StaffPermission } from '@simplexd/domain/authz';
import { can, transact, type AdminContext } from '../context';

/** Helpers shared by the admin configuration modules (pricing, templates, requirements, SLA). */

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** Throws unless the actor holds at least one of the permissions (no resource rules apply to configuration). */
export function authorizeAny(ctx: AdminContext, permissions: StaffPermission[]): void {
  if (!ctx.identity.session)
    throw new AuthorizationError({
      allowed: false,
      code: 'unauthenticated',
      reason: 'sign in required',
    });
  if (permissions.some((p) => can(ctx, p))) return;
  throw new AuthorizationError({
    allowed: false,
    code: 'no_permission',
    reason: `requires one of ${permissions.join(', ')}`,
  });
}

/** Publication decisions require a verified authenticator (brief §11: data publication). */
export function requireVerifiedMfa(ctx: AdminContext, action: string): void {
  if (!ctx.identity.actor.mfaVerified)
    throw new AuthorizationError({
      allowed: false,
      code: 'mfa_required',
      reason: `${action} requires a verified authenticator`,
    });
}

export async function userRefs(
  tx: Transaction,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, { id: string; name: string }>> {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  const out = new Map<string, { id: string; name: string }>();
  if (unique.length === 0) return out;
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name });
  return out;
}

export async function serviceNames(
  tx: Transaction,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await tx
    .select({ id: schema.services.id, name: schema.services.name })
    .from(schema.services)
    .where(inArray(schema.services.id, unique));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/**
 * Serialises writers that must keep a "one active per key" rule (one active
 * report template per kind, one active SLA policy per service and stage)
 * for the rest of the transaction.
 */
export async function lockKey(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

export const CONFIG_READ_PERMISSIONS: StaffPermission[] = [
  'pricing.manage',
  'quotes.issue',
  'sla.manage',
  'reports.draft',
  'reports.review',
  'reports.release',
  'service_requests.read_all',
];

export interface ServiceOption {
  id: string;
  slug: string;
  name: string;
  category: 'core' | 'expansion';
}

/** Services for configuration pickers (any configuration reader). */
export async function listConfigServices(ctx: AdminContext): Promise<ServiceOption[]> {
  authorizeAny(ctx, CONFIG_READ_PERMISSIONS);
  return transact(ctx, (tx) =>
    tx
      .select({
        id: schema.services.id,
        slug: schema.services.slug,
        name: schema.services.name,
        category: schema.services.category,
      })
      .from(schema.services)
      .orderBy(asc(schema.services.category), asc(schema.services.sortOrder)),
  );
}

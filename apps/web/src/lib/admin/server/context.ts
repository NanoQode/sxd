import 'server-only';
import { inArray } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  authorizeStaff,
  hasStaffPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import { createFinanceRuntime, type FinanceActor, type FinanceRuntime } from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Helpers for admin page read models. Every function here runs under the
 * staff actor's row-level security context and checks an explicit staff
 * permission first; pages call these from server components.
 */

export function can(identity: RequestIdentity, permission: StaffPermission): boolean {
  return hasStaffPermission(identity.actor, permission);
}

/** Throws unless the actor holds at least one of the permissions (resource rules applied). */
export function requireAnyStaff(
  identity: RequestIdentity,
  permissions: StaffPermission[],
  resource?: ResourceRef,
): StaffPermission {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  let lastReason = 'forbidden';
  for (const p of permissions) {
    const decision = authorizeStaff(identity.actor, p, resource);
    if (decision.allowed) return p;
    lastReason = decision.reason;
  }
  throw new ApiError('forbidden', lastReason);
}

export function staffTx<T>(identity: RequestIdentity, fn: (tx: Transaction) => Promise<T>) {
  return withActor(getDb(), identity.ctx, fn);
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function userIdOf(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

/** Display names for a set of user ids. */
export async function userNames(tx: Transaction, ids: Iterable<string | null | undefined>) {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  const map = new Map<string, { name: string; email: string }>();
  if (unique.length === 0) return map;
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  for (const r of rows) map.set(r.id, { name: r.name, email: r.email });
  return map;
}

/** Organisation names for a set of ids. */
export async function orgNames(tx: Transaction, ids: Iterable<string | null | undefined>) {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const rows = await tx
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(inArray(schema.organization.id, unique));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

const cache = globalThis as unknown as { __simplexdAdminFinanceRuntime?: FinanceRuntime };

/** Finance runtime and actor for server components (no HTTP request in scope). */
export function financeFor(identity: RequestIdentity): { rt: FinanceRuntime; fa: FinanceActor } {
  if (!cache.__simplexdAdminFinanceRuntime) {
    cache.__simplexdAdminFinanceRuntime = createFinanceRuntime({ db: getDb() });
  }
  return {
    rt: cache.__simplexdAdminFinanceRuntime,
    fa: {
      actor: identity.actor,
      ctx: { ...identity.ctx },
      correlationId: identity.ctx.correlationId ?? 'admin-page',
      ipHash: null,
      userAgent: null,
    },
  };
}

/** Masks an email for actors without `customers.read_sensitive`: a***@example.com. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
}

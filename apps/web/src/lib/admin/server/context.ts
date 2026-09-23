import 'server-only';
import { inArray } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  AuthorizationError,
  authorizeStaff,
  hasStaffPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { FinanceActor, FinanceRuntime } from '@simplexd/finance';
import type { RequestIdentity } from '@/lib/auth/session';
import { getFinanceRuntime } from '@/server/finance/runtime';

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

/** Finance runtime (shared with the API routes) and actor for server components. */
export function financeFor(identity: RequestIdentity): { rt: FinanceRuntime; fa: FinanceActor } {
  return {
    rt: getFinanceRuntime(),
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

/** A server read that may be refused (permission, MFA, feature flag) without failing the page. */
export type Loaded<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export async function attempt<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, code: err.code, message: err.message };
    if (err instanceof AuthorizationError) {
      const code = err.decision.code;
      const passthrough = code === 'mfa_required' || code === 'feature_disabled' || code === 'unauthenticated';
      return { ok: false, code: passthrough ? code : 'forbidden', message: err.message };
    }
    throw err;
  }
}

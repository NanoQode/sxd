import 'server-only';
import { ApiError } from '@simplexd/contracts';
import { getDb, withActor, type Database, type Transaction } from '@simplexd/db';
import {
  assertAllowed,
  authorizeStaff,
  hasStaffPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Execution context for admin server functions. Routes build it from the
 * request identity; integration tests build it directly with the test
 * database so the same functions are exercised without HTTP.
 */
export interface AdminContext {
  identity: RequestIdentity;
  db: Database;
  correlationId: string | null;
}

export function adminContext(
  identity: RequestIdentity,
  correlationId?: string | null,
  db?: Database,
): AdminContext {
  return {
    identity,
    db: db ?? getDb(),
    correlationId: correlationId ?? identity.ctx.correlationId ?? null,
  };
}

/** Staff permission check with the resource relationship rules (own work, MFA). */
export function authorize(
  ctx: AdminContext,
  permission: StaffPermission,
  resource?: ResourceRef,
): void {
  if (!ctx.identity.session) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeStaff(ctx.identity.actor, permission, resource));
}

export function can(ctx: AdminContext, permission: StaffPermission): boolean {
  return hasStaffPermission(ctx.identity.actor, permission);
}

export function actorId(ctx: AdminContext): string {
  const id = ctx.identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

/** Runs `fn` in a transaction carrying the actor's row-level security context. */
export function transact<T>(ctx: AdminContext, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withActor(
    ctx.db,
    { ...ctx.identity.ctx, correlationId: ctx.correlationId ?? undefined },
    fn,
  );
}

export function versionConflict(currentVersion: number | string): ApiError {
  return new ApiError(
    'version_conflict',
    'this record changed since you loaded it; reload and apply your change again',
    { details: { currentVersion } },
  );
}

export function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw versionConflict(current);
}

/** Concurrency token for rows without a version counter. */
export function assertUpdatedAt(current: Date, expected: string | undefined): void {
  if (expected === undefined) return;
  const expectedMs = new Date(expected).getTime();
  if (Number.isNaN(expectedMs) || Math.abs(expectedMs - current.getTime()) > 999) {
    throw versionConflict(current.toISOString());
  }
}

export function notFound(what: string): ApiError {
  return new ApiError('not_found', `${what} not found`);
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Shallow JSON diff used for audit entries: only keys whose value changed. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return { before: b, after: a };
}

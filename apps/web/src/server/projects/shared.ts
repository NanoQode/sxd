import 'server-only';
import { ApiError } from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';

/** Small helpers shared by the project delivery services. */

export function userIdOf(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export function isBroadStaff(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.some((r) => r === 'super_admin' || r === 'operations_manager');
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const kobo = (v: bigint | null | undefined): string | null => (v == null ? null : v.toString());

export function toKobo(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new ApiError('validation_failed', `invalid kobo amount "${value}"`);
  return BigInt(value);
}

export function notFound(what: string): ApiError {
  return new ApiError('not_found', `${what} not found`);
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

/** Concurrency token for rows without a version counter (compares updatedAt to the second). */
export function assertUpdatedAt(current: Date, expected: string | undefined): void {
  if (expected === undefined) return;
  const expectedMs = new Date(expected).getTime();
  if (Number.isNaN(expectedMs) || Math.abs(expectedMs - current.getTime()) > 999) {
    throw versionConflict(current.toISOString());
  }
}

export function invalidTransition(message: string, details?: unknown): ApiError {
  return new ApiError('invalid_transition', message, { details });
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [isoDate, id] = raw.split('|');
    if (!isoDate || !id) return null;
    const createdAt = new Date(isoDate);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ServiceOptions {
  correlationId?: string;
}

/** Actor context for the transaction, carrying the request correlation id. */
export function ctxFor(identity: RequestIdentity, options?: ServiceOptions) {
  return { ...identity.ctx, correlationId: options?.correlationId ?? identity.ctx.correlationId };
}

/** Keyset page slicing for lists fetched with limit + 1. */
export function pageSlice<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items[items.length - 1] : null;
  return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
}

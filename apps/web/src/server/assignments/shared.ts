import 'server-only';
import { inArray } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import {
  applyActorContext,
  schema,
  type ActorContext,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Small helpers shared by the collaboration modules (properties, assignments,
 * tasks, notes, conversations). They mirror the portal helpers in
 * `@/server/portal/elevate` so these modules do not depend on a directory
 * owned by another team.
 */

export interface ServiceOptions {
  correlationId?: string;
}

export function requireUserId(identity: RequestIdentity): string {
  const id = identity.session?.user.id;
  if (!id) throw new ApiError('unauthenticated', 'sign in required');
  return id;
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export function isPartnerIdentity(identity: RequestIdentity): boolean {
  return identity.actor.isPartner;
}

/** Row-level security context for this request, carrying the correlation id into audit rows. */
export function actorContext(
  identity: RequestIdentity,
  options: ServiceOptions = {},
): ActorContext {
  return options.correlationId
    ? { ...identity.ctx, correlationId: options.correlationId }
    : identity.ctx;
}

/**
 * Elevates the current transaction (bypass) for the rest of its life. Audit
 * and outbox rows are appendable by every actor (migration 0002), so this is
 * NOT needed for them. It is reserved for the cases the row-level policies
 * cannot express, each documented at the call site:
 *  - inserting a `properties` row as a customer: the table's WITH CHECK policy
 *    calls `app.can_access_property(id)`, which cannot see the row being inserted;
 *  - inserting a `conversations` row and its first participant as a non-staff
 *    creator: `app.can_access_conversation(id)` needs a participant row that
 *    cannot exist before the conversation does;
 *  - reading `tasks`/`notes` for a partner who reaches the entity through an
 *    accepted/active assignment: those policies have no assignment clause.
 * Every access-proving read and every policy decision must run before it.
 */
export async function elevate(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: true });
}

/** Restores the caller's own context after a narrowly scoped elevated read. */
export async function demote(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: false });
}

/** Encodes a keyset cursor (timestamp + id) for stable pagination. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function versionConflict(currentVersion?: number): ApiError {
  return new ApiError(
    'version_conflict',
    'this record changed since you loaded it; reload and try again',
    currentVersion === undefined ? {} : { details: { currentVersion } },
  );
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Display names for a set of user ids (the user table carries no row-level policy). */
export async function userNameMap(
  tx: DbExecutor,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function uniqueIds(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => Boolean(v)))];
}

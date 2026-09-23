import 'server-only';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import {
  assertAllowed,
  AuthorizationError,
  authorizeAny,
  authorizeStaff,
  hasStaffPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Listing authorisation (default deny, re-checked on every call):
 *  - the owning organisation reads with `org.read` and edits, submits,
 *    withdraws and re-confirms with `org.listings.manage`;
 *  - staff read with `content.publish`, `rentals.manage` or `customers.read`;
 *  - moderation decisions (publish a revision, reject, request changes, mark
 *    duplicate) need `content.publish`, matching the listing workflow machine;
 *  - verification checks (what was checked, by whom, when, until when) need
 *    `rentals.manage`, the same duty that verifies owner authorities;
 *  - transaction tracking (milestones, outcome) accepts the owner's
 *    `org.listings.manage` or staff `rentals.manage`.
 * Row-level security is the second net: another organisation's draft is not
 * visible at all, so such requests end as `not_found`.
 */

export type ListingRow = typeof schema.listings.$inferSelect;
export type RevisionRow = typeof schema.listingRevisions.$inferSelect;

export type ListingAccessMode = 'read' | 'manage' | 'moderate' | 'verify' | 'transaction';

export const STAFF_LISTING_READ: StaffPermission[] = [
  'content.publish',
  'rentals.manage',
  'customers.read',
];

export function listingRef(organizationId: string, id?: string): ResourceRef {
  return { type: 'listing', id, organizationId };
}

export function canStaffReadListings(identity: RequestIdentity): boolean {
  return STAFF_LISTING_READ.some((p) => hasStaffPermission(identity.actor, p));
}

export function assertListingAccess(
  identity: RequestIdentity,
  ref: ResourceRef,
  mode: ListingAccessMode,
): void {
  switch (mode) {
    case 'read':
      assertAllowed(
        authorizeAny(
          identity.actor,
          [
            { staff: 'content.publish' },
            { staff: 'rentals.manage' },
            { staff: 'customers.read' },
            { org: 'org.read' },
          ],
          ref,
        ),
      );
      return;
    case 'manage':
      assertAllowed(authorizeAny(identity.actor, [{ org: 'org.listings.manage' }], ref));
      return;
    case 'moderate':
      assertAllowed(authorizeStaff(identity.actor, 'content.publish', ref));
      return;
    case 'verify':
      assertAllowed(authorizeStaff(identity.actor, 'rentals.manage', ref));
      return;
    case 'transaction':
      assertAllowed(
        authorizeAny(
          identity.actor,
          [{ staff: 'rentals.manage' }, { org: 'org.listings.manage' }],
          ref,
        ),
      );
      return;
  }
}

/** Loads a listing under the caller's row-level security context. */
export async function loadListing(tx: DbExecutor, id: string): Promise<ListingRow | null> {
  const rows = await tx.select().from(schema.listings).where(eq(schema.listings.id, id));
  return rows[0] ?? null;
}

/**
 * Loads a listing the caller may act on. Visibility is proven by the SQL read,
 * the permission by the policy. A customer outside the owning organisation
 * who can see a published listing still gets `not_found` from the private
 * endpoints (the public pages are the way to read it).
 */
export async function requireListing(
  tx: DbExecutor,
  identity: RequestIdentity,
  id: string,
  mode: ListingAccessMode,
): Promise<ListingRow> {
  const row = await loadListing(tx, id);
  if (!row) throw new ApiError('not_found', 'listing not found');
  const isStaff = identity.actor.staffRoles.length > 0;
  const ref = listingRef(row.organizationId, row.id);
  if (!isStaff) {
    try {
      assertListingAccess(identity, ref, 'read');
    } catch (err) {
      if (err instanceof AuthorizationError) throw new ApiError('not_found', 'listing not found');
      throw err;
    }
  }
  assertListingAccess(identity, ref, mode);
  return row;
}

export async function loadRevision(
  tx: DbExecutor,
  listingId: string,
  version: number,
): Promise<RevisionRow | null> {
  const rows = await tx
    .select()
    .from(schema.listingRevisions)
    .where(
      and(
        eq(schema.listingRevisions.listingId, listingId),
        eq(schema.listingRevisions.version, version),
      ),
    );
  return rows[0] ?? null;
}

export async function requireRevision(
  tx: DbExecutor,
  listingId: string,
  version: number,
): Promise<RevisionRow> {
  const row = await loadRevision(tx, listingId, version);
  if (!row) throw new ApiError('not_found', `revision ${version} not found`);
  return row;
}

/** Refuses a stale write: the caller must have seen the current listing version. */
export function assertListingVersion(row: ListingRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw new ApiError(
      'version_conflict',
      'the listing changed since you loaded it; reload and try again',
      { details: { expectedVersion, currentVersion: row.version } },
    );
  }
}

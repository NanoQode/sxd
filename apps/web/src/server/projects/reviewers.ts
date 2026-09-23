import 'server-only';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { ApiError, type ReviewerDto, type ReviewersQuery } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { STAFF_ROLES, STAFF_ROLE_PERMISSIONS, type StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { demote, elevate } from '@/server/assignments/shared';
import { ctxFor, userIdOf } from './shared';

/**
 * Staff eligible to be named as the professional reviewer of a report: every
 * user holding an active staff role whose bundle carries `reports.review`,
 * minus the requester (nobody reviews their own work). Available to staff
 * and partners, since both draft reports; customers never see the staff
 * directory. Only id, name and the reviewing role are returned.
 */

/** Roles whose permission bundle includes `reports.review`. */
export const REVIEWER_ROLES: readonly StaffRole[] = STAFF_ROLES.filter((role) =>
  STAFF_ROLE_PERMISSIONS[role].has('reports.review'),
);

export async function listReviewers(
  identity: RequestIdentity,
  query: ReviewersQuery,
): Promise<{ items: ReviewerDto[] }> {
  const userId = userIdOf(identity);
  const staff = identity.actor.staffRoles.length > 0;
  if (!staff && !identity.actor.isPartner) {
    throw new ApiError('forbidden', 'the reviewer directory is available to staff and partners');
  }
  const ctx = ctxFor(identity);
  return withActor(getDb(), ctx, async (tx) => {
    let pmUserId: string | null = null;
    if (query.projectId) {
      // Under the caller's own row-level context: a partner only resolves projects they are assigned to.
      const [project] = await tx
        .select({ pmUserId: schema.projects.pmUserId })
        .from(schema.projects)
        .where(eq(schema.projects.id, query.projectId));
      pmUserId = project?.pmUserId ?? null;
    }
    // `staff_roles` is readable by staff and by each user for their own rows;
    // a partner's directory read runs elevated after the checks above.
    if (!staff) await elevate(tx, ctx);
    const rows = await tx
      .select({
        userId: schema.staffRoles.userId,
        role: schema.staffRoles.role,
        name: schema.user.name,
        banned: schema.user.banned,
      })
      .from(schema.staffRoles)
      .innerJoin(schema.user, eq(schema.user.id, schema.staffRoles.userId))
      .where(
        and(
          inArray(schema.staffRoles.role, [...REVIEWER_ROLES]),
          isNull(schema.staffRoles.revokedAt),
          ne(schema.staffRoles.userId, userId),
        ),
      )
      .orderBy(asc(schema.user.name), asc(schema.staffRoles.userId));
    if (!staff) await demote(tx, ctx);
    const byUser = new Map<string, ReviewerDto>();
    for (const r of rows) {
      if (r.banned) continue;
      const existing = byUser.get(r.userId);
      // Prefer the most specific reviewing role for display (PM over ops over admin).
      if (!existing || REVIEWER_ROLES.indexOf(r.role) > REVIEWER_ROLES.indexOf(existing.role as StaffRole)) {
        byUser.set(r.userId, {
          id: r.userId,
          name: r.name,
          role: r.role,
          isProjectManager: pmUserId === r.userId,
        });
      }
    }
    const items = [...byUser.values()].sort((a, b) =>
      a.isProjectManager === b.isProjectManager
        ? a.name.localeCompare(b.name)
        : a.isProjectManager
          ? -1
          : 1,
    );
    return { items };
  });
}

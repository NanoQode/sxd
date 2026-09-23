import 'server-only';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { iso, requireAnyStaff, staffTx } from './context';

export interface PartnerRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  displayName: string | null;
  partnerType: string;
  verificationStatus: string;
  verifiedAt: string | null;
  verificationExpiresAt: string | null;
  availabilityStatus: string;
  coverageStateCount: number;
  /** Free-text conflict disclosure recorded on the profile, if any. */
  conflictDisclosure: string | null;
  credentialCount: number;
  ratingAverage: string | null;
  assignments: { active: number; completed: number; declined: number; revoked: number };
  bids: { submitted: number; awarded: number };
  tenderInvitations: number;
}

/** Partner directory with assignment and tender performance counts. */
export async function listPartners(
  identity: RequestIdentity,
  filters: { verificationStatus?: string; partnerType?: string; q?: string },
): Promise<PartnerRow[]> {
  requireAnyStaff(identity, [
    'access.partners.verify',
    'service_requests.assign',
    'tenders.manage',
    'projects.manage',
  ]);
  return staffTx(identity, async (tx) => {
    const rows = await tx
      .select({ p: schema.partnerProfiles, name: schema.user.name, email: schema.user.email })
      .from(schema.partnerProfiles)
      .innerJoin(schema.user, eq(schema.user.id, schema.partnerProfiles.userId))
      .orderBy(asc(schema.user.name));
    const filtered = rows.filter((r) => {
      if (filters.verificationStatus && r.p.verificationStatus !== filters.verificationStatus)
        return false;
      if (filters.partnerType && r.p.partnerType !== filters.partnerType) return false;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        const hay = `${r.name} ${r.email} ${r.p.displayName ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const ids = filtered.map((r) => r.p.userId);
    const assignmentCounts = ids.length
      ? await tx
          .select({
            userId: schema.assignments.assigneeUserId,
            status: schema.assignments.status,
            n: count(),
          })
          .from(schema.assignments)
          .where(inArray(schema.assignments.assigneeUserId, ids))
          .groupBy(schema.assignments.assigneeUserId, schema.assignments.status)
      : [];
    const bidCounts = ids.length
      ? await tx
          .select({ userId: schema.bids.partnerUserId, status: schema.bids.status, n: count() })
          .from(schema.bids)
          .where(inArray(schema.bids.partnerUserId, ids))
          .groupBy(schema.bids.partnerUserId, schema.bids.status)
      : [];
    const invitationCounts = ids.length
      ? await tx
          .select({ userId: schema.tenderInvitations.partnerUserId, n: count() })
          .from(schema.tenderInvitations)
          .where(inArray(schema.tenderInvitations.partnerUserId, ids))
          .groupBy(schema.tenderInvitations.partnerUserId)
      : [];
    const a = new Map<string, Record<string, number>>();
    for (const c of assignmentCounts) {
      const rec = a.get(c.userId) ?? {};
      rec[c.status] = Number(c.n);
      a.set(c.userId, rec);
    }
    const b = new Map<string, Record<string, number>>();
    for (const c of bidCounts) {
      const rec = b.get(c.userId) ?? {};
      rec[c.status] = Number(c.n);
      b.set(c.userId, rec);
    }
    const inv = new Map(invitationCounts.map((i) => [i.userId, Number(i.n)]));
    return filtered.map((r) => {
      const ac = a.get(r.p.userId) ?? {};
      const bc = b.get(r.p.userId) ?? {};
      const coverage = Array.isArray(r.p.coverageStateIds)
        ? (r.p.coverageStateIds as unknown[]).length
        : 0;
      return {
        id: r.p.id,
        userId: r.p.userId,
        name: r.name,
        email: r.email,
        displayName: r.p.displayName ?? null,
        partnerType: r.p.partnerType,
        verificationStatus: r.p.verificationStatus,
        verifiedAt: iso(r.p.verifiedAt),
        verificationExpiresAt: iso(r.p.verificationExpiresAt),
        availabilityStatus: r.p.availabilityStatus,
        coverageStateCount: coverage,
        conflictDisclosure: r.p.conflictDisclosures?.trim() ? r.p.conflictDisclosures.trim() : null,
        credentialCount: Array.isArray(r.p.credentials) ? r.p.credentials.length : 0,
        ratingAverage:
          r.p.ratingAverage === null || r.p.ratingAverage === undefined
            ? null
            : String(r.p.ratingAverage),
        assignments: {
          active: (ac.active ?? 0) + (ac.accepted ?? 0) + (ac.proposed ?? 0),
          completed: ac.completed ?? 0,
          declined: ac.declined ?? 0,
          revoked: ac.revoked ?? 0,
        },
        bids: {
          submitted:
            (bc.submitted ?? 0) + (bc.evaluated ?? 0) + (bc.awarded ?? 0) + (bc.unsuccessful ?? 0),
          awarded: bc.awarded ?? 0,
        },
        tenderInvitations: inv.get(r.p.userId) ?? 0,
      };
    });
  });
}

/** Verified partner users for tender invitations and RFQ supplier invitations. */
export async function listInvitablePartners(identity: RequestIdentity) {
  requireAnyStaff(identity, ['tenders.manage', 'procurement.manage', 'service_requests.assign']);
  return staffTx(identity, (tx) =>
    tx
      .select({
        userId: schema.partnerProfiles.userId,
        name: schema.user.name,
        email: schema.user.email,
        partnerType: schema.partnerProfiles.partnerType,
        verificationStatus: schema.partnerProfiles.verificationStatus,
      })
      .from(schema.partnerProfiles)
      .innerJoin(schema.user, eq(schema.user.id, schema.partnerProfiles.userId))
      .where(sql`${schema.user.banned} is not true`)
      .orderBy(asc(schema.user.name)),
  );
}

import 'server-only';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { can, orgNames, requireAnyStaff, staffTx, userNames, userIdOf } from './context';

export interface ReportQueueRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  currentVersion: number;
  releasedVersion: number | null;
  projectId: string | null;
  projectName: string | null;
  serviceRequestId: string | null;
  organizationId: string;
  organizationName: string;
  authorName: string | null;
  namedReviewerName: string | null;
  namedReviewerUserId: string | null;
  createdBy: string | null;
  /** True when the caller is the named reviewer (and not the author). */
  isMyReview: boolean;
  isAuthor: boolean;
  updatedAt: string;
}

const OPEN_STATES = ['draft', 'in_review', 'changes_requested', 'approved'];

/** Review queue across projects (needs `reports.review`, `reports.draft` or `reports.release`). */
export async function listReportQueue(
  identity: RequestIdentity,
  filters: { status?: string; mineOnly?: boolean; page: number; pageSize: number },
): Promise<{ items: ReportQueueRow[]; total: number; counts: Record<string, number> }> {
  requireAnyStaff(identity, ['reports.review', 'reports.draft', 'reports.release']);
  const me = userIdOf(identity);
  const projectScoped = !can(identity, 'projects.read_all') && !can(identity, 'reports.release');
  return staffTx(identity, async (tx) => {
    const where = and(
      filters.status
        ? eq(schema.reports.status, filters.status as never)
        : inArray(schema.reports.status, OPEN_STATES as never[]),
      filters.mineOnly ? eq(schema.reports.namedReviewerUserId, me) : undefined,
      projectScoped ? eq(schema.reports.namedReviewerUserId, me) : undefined,
    );
    const [totalRow] = await tx.select({ n: count() }).from(schema.reports).where(where);
    const rows = await tx
      .select({ r: schema.reports, projectName: schema.projects.name })
      .from(schema.reports)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.reports.projectId))
      .where(where)
      .orderBy(desc(schema.reports.updatedAt))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const countRows = await tx
      .select({ status: schema.reports.status, n: count() })
      .from(schema.reports)
      .groupBy(schema.reports.status);
    const names = await userNames(
      tx,
      rows.flatMap((r) => [r.r.createdBy, r.r.namedReviewerUserId]),
    );
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.r.organizationId),
    );
    const counts: Record<string, number> = {};
    for (const c of countRows) counts[c.status] = Number(c.n);
    return {
      total: Number(totalRow?.n ?? 0),
      counts,
      items: rows.map((r) => ({
        id: r.r.id,
        title: r.r.title,
        kind: r.r.kind,
        status: r.r.status,
        currentVersion: r.r.currentVersion,
        releasedVersion: r.r.releasedVersion ?? null,
        projectId: r.r.projectId ?? null,
        projectName: r.projectName ?? null,
        serviceRequestId: r.r.serviceRequestId ?? null,
        organizationId: r.r.organizationId,
        organizationName: orgs.get(r.r.organizationId) ?? r.r.organizationId,
        authorName: r.r.createdBy ? (names.get(r.r.createdBy)?.name ?? null) : null,
        namedReviewerName: r.r.namedReviewerUserId
          ? (names.get(r.r.namedReviewerUserId)?.name ?? null)
          : null,
        namedReviewerUserId: r.r.namedReviewerUserId ?? null,
        createdBy: r.r.createdBy ?? null,
        isMyReview: r.r.namedReviewerUserId === me && r.r.createdBy !== me,
        isAuthor: r.r.createdBy === me,
        updatedAt: r.r.updatedAt.toISOString(),
      })),
    };
  });
}

/** Author/reviewer display names for a report page. */
export async function reportPeople(identity: RequestIdentity, userIds: Array<string | null>) {
  return staffTx(identity, async (tx) => {
    const names = await userNames(tx, userIds);
    return Object.fromEntries([...names.entries()].map(([id, v]) => [id, v.name]));
  });
}

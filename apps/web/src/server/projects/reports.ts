import 'server-only';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type EvidenceDto,
  type Page,
  type ReportCreate,
  type ReportDetailDto,
  type ReportDto,
  type ReportRelease,
  type ReportReview,
  type ReportRevisionCreate,
  type ReportRevisionDto,
  type ReportRevisionInput,
  type ReportSubmit,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { hasStaffPermission, type StaffRole } from '@simplexd/domain/authz';
import {
  assertNotAuthor,
  canAddRevision,
  reportTransition,
  reviewTransitionTarget,
  revisionState,
  validateNamedReviewer,
} from '@simplexd/domain/projects';
import { availableTransitions, reportMachine } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, isCustomerOf, requireProject, type AccessCheck, type ProjectAccess } from './access';
import { toEvidenceDto } from './evidence';
import {
  assertVersion,
  ctxFor,
  decodeCursor,
  invalidTransition,
  iso,
  isStaffIdentity,
  notFound,
  pageSlice,
  userIdOf,
  versionConflict,
  type ServiceOptions,
} from './shared';

type ReportRow = typeof schema.reports.$inferSelect;
type RevisionRow = typeof schema.reportRevisions.$inferSelect;

const DRAFT_CHECKS: AccessCheck[] = [{ staff: 'reports.draft' }, { partner: 'partner.reports.draft' }];

async function userName(tx: Transaction, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [u] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, id));
  return u?.name ?? null;
}

async function toReportDto(tx: Transaction, r: ReportRow): Promise<ReportDto> {
  return {
    id: r.id,
    organizationId: r.organizationId,
    projectId: r.projectId,
    serviceRequestId: r.serviceRequestId,
    siteVisitId: r.siteVisitId,
    kind: r.kind,
    title: r.title,
    status: r.status,
    currentVersion: r.currentVersion,
    releasedVersion: r.releasedVersion,
    releasedAt: iso(r.releasedAt),
    releasedBy: r.releasedBy,
    customerVisible: r.customerVisible,
    namedReviewerUserId: r.namedReviewerUserId,
    namedReviewerName: await userName(tx, r.namedReviewerUserId),
    createdBy: r.createdBy,
    authorName: await userName(tx, r.createdBy),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toRevisionDto(r: ReportRow, rev: RevisionRow): ReportRevisionDto {
  return {
    id: rev.id,
    reportId: rev.reportId,
    version: rev.version,
    summary: rev.summary,
    bodyMarkdown: rev.bodyMarkdown,
    findings: rev.findings ?? null,
    attachmentFileIds: rev.attachmentFileIds ?? [],
    scopeLimitations: rev.scopeLimitations,
    reviewerUserId: rev.reviewerUserId,
    reviewDecision: rev.reviewDecision,
    reviewNote: rev.reviewNote,
    reviewedAt: iso(rev.reviewedAt),
    createdBy: rev.createdBy,
    createdAt: rev.createdAt.toISOString(),
    state: revisionState({
      version: rev.version,
      currentVersion: r.currentVersion,
      releasedVersion: r.releasedVersion,
      reportStatus: r.status,
    }),
  };
}

async function toDetail(tx: Transaction, identity: RequestIdentity, r: ReportRow, access: ProjectAccess): Promise<ReportDetailDto> {
  const customer = isCustomerOf(identity, access);
  const revisions = await tx
    .select()
    .from(schema.reportRevisions)
    .where(
      and(
        eq(schema.reportRevisions.reportId, r.id),
        // Customers only ever read the released revision.
        customer ? eq(schema.reportRevisions.version, r.releasedVersion ?? -1) : undefined,
      ),
    )
    .orderBy(desc(schema.reportRevisions.version));
  const transitions = customer ? [] : availableTransitions(reportMachine, r.status, 'staff').map((t) => ({ to: t.to, reasonRequired: Boolean(t.reasonRequired) }));
  return { ...(await toReportDto(tx, r)), revisions: revisions.map((rev) => toRevisionDto(r, rev)), availableTransitions: transitions };
}

async function loadReport(tx: Transaction, identity: RequestIdentity, id: string, checks: AccessCheck[]) {
  const [r] = await tx.select().from(schema.reports).where(eq(schema.reports.id, id));
  if (!r || !r.projectId) throw notFound('report');
  const access = await requireProject(tx, identity, r.projectId, checks, { createdBy: r.createdBy });
  return { r, access };
}

async function insertRevision(tx: Transaction, reportId: string, version: number, input: ReportRevisionInput, createdBy: string): Promise<RevisionRow> {
  const [rev] = await tx
    .insert(schema.reportRevisions)
    .values({
      reportId,
      version,
      summary: input.summary ?? null,
      bodyMarkdown: input.bodyMarkdown,
      findings: input.findings ?? null,
      attachmentFileIds: input.attachmentFileIds ?? [],
      scopeLimitations: input.scopeLimitations ?? null,
      createdBy,
    })
    .returning();
  return rev!;
}

/** Draft a report (staff `reports.draft` or an assigned partner with `partner.reports.draft`). */
export async function createReport(
  identity: RequestIdentity,
  projectId: string,
  input: ReportCreate,
  options: ServiceOptions = {},
): Promise<ReportDetailDto & { idempotentReplay: boolean }> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, DRAFT_CHECKS);
    if (input.offlineClientId) {
      const [existing] = await tx.select().from(schema.reports).where(eq(schema.reports.offlineClientId, input.offlineClientId));
      if (existing) {
        if (existing.createdBy !== actorId) throw new ApiError('conflict', 'this offline id was already used by another user');
        return { ...(await toDetail(tx, identity, existing, access)), idempotentReplay: true };
      }
    }
    if (input.siteVisitId) {
      const [v] = await tx.select({ projectId: schema.siteVisits.projectId }).from(schema.siteVisits).where(eq(schema.siteVisits.id, input.siteVisitId));
      if (!v || v.projectId !== projectId) throw new ApiError('validation_failed', 'siteVisitId does not belong to this project');
    }
    const [row] = await tx
      .insert(schema.reports)
      .values({
        organizationId: access.project.organizationId,
        projectId,
        serviceRequestId: input.serviceRequestId ?? access.project.serviceRequestId,
        siteVisitId: input.siteVisitId ?? null,
        kind: input.kind,
        title: input.title,
        status: 'draft',
        currentVersion: input.initialRevision ? 1 : 0,
        offlineClientId: input.offlineClientId ?? null,
        createdBy: actorId,
      })
      .returning();
    if (input.initialRevision) await insertRevision(tx, row!.id, 1, input.initialRevision, actorId);
    await recordAudit(tx, identity, {
      action: 'report.drafted',
      entityType: 'report',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { projectId, kind: input.kind, title: input.title, siteVisitId: input.siteVisitId ?? null },
      correlationId: options.correlationId,
    });
    return { ...(await toDetail(tx, identity, row!, access)), idempotentReplay: false };
  });
}

export async function getReport(identity: RequestIdentity, id: string): Promise<ReportDetailDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, [...PROJECT_READ_CHECKS, { org: 'org.reports.view' }]);
    if (isCustomerOf(identity, access) && !r.customerVisible) throw notFound('report');
    return toDetail(tx, identity, r, access);
  });
}

export async function listReports(
  identity: RequestIdentity,
  projectId: string,
  query: { cursor?: string; limit: number; status?: ReportRow['status']; kind?: ReportRow['kind'] },
): Promise<Page<ReportDto>> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [...PROJECT_READ_CHECKS, { org: 'org.reports.view' }]);
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.reports)
      .where(
        and(
          eq(schema.reports.projectId, projectId),
          isCustomerOf(identity, access) ? eq(schema.reports.customerVisible, true) : undefined,
          query.status ? eq(schema.reports.status, query.status) : undefined,
          query.kind ? eq(schema.reports.kind, query.kind) : undefined,
          cursor ? or(lt(schema.reports.createdAt, cursor.createdAt), and(eq(schema.reports.createdAt, cursor.createdAt), lt(schema.reports.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(schema.reports.createdAt), desc(schema.reports.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    const items: ReportDto[] = [];
    for (const r of page.items) items.push(await toReportDto(tx, r));
    return { items, nextCursor: page.nextCursor };
  });
}

/** New revision: a new version; after a release the released revision stays frozen and a new draft starts. */
export async function addReportRevision(
  identity: RequestIdentity,
  id: string,
  input: ReportRevisionCreate,
  options: ServiceOptions = {},
): Promise<ReportDetailDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, DRAFT_CHECKS);
    assertVersion(r.version, input.expectedVersion);
    const decision = canAddRevision(r.status);
    if (!decision.ok) throw invalidTransition(decision.reason, { status: r.status });
    if (decision.supersedesRelease) {
      const t = reportTransition('released', 'superseded', 'staff');
      if (!t.ok) throw invalidTransition(t.message ?? 'cannot supersede the release');
    }
    const version = r.currentVersion + 1;
    const { expectedVersion: _v, ...revisionInput } = input;
    await insertRevision(tx, r.id, version, revisionInput, actorId);
    const [updated] = await tx
      .update(schema.reports)
      .set({ currentVersion: version, status: decision.nextStatus, version: r.version + 1 })
      .where(and(eq(schema.reports.id, id), eq(schema.reports.version, r.version)))
      .returning();
    if (!updated) throw versionConflict(r.version);
    await recordAudit(tx, identity, {
      action: decision.supersedesRelease ? 'report.release_superseded_by_draft' : 'report.revision_added',
      entityType: 'report',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { currentVersion: r.currentVersion, status: r.status },
      after: { currentVersion: version, status: decision.nextStatus, releasedVersion: r.releasedVersion },
      correlationId: options.correlationId,
    });
    return toDetail(tx, identity, updated, access);
  });
}

async function reviewerHoldsPermission(tx: Transaction, userId: string): Promise<boolean> {
  const roles = await tx
    .select({ role: schema.staffRoles.role })
    .from(schema.staffRoles)
    .where(and(eq(schema.staffRoles.userId, userId), isNull(schema.staffRoles.revokedAt)));
  return hasStaffPermission(
    { userId, staffRoles: roles.map((r) => r.role as StaffRole), memberships: [], activeOrganizationId: null, isPartner: false, mfaVerified: false },
    'reports.review',
  );
}

/** draft/changes_requested → in_review with a named professional reviewer who is not the author. */
export async function submitReport(
  identity: RequestIdentity,
  id: string,
  input: ReportSubmit,
  options: ServiceOptions = {},
): Promise<ReportDetailDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, DRAFT_CHECKS);
    assertVersion(r.version, input.expectedVersion);
    if (r.currentVersion === 0) throw invalidTransition('add a revision before submitting the report for review');
    const named = validateNamedReviewer({ authorUserId: r.createdBy, reviewerUserId: input.namedReviewerUserId });
    if (!named.ok) throw new ApiError('validation_failed', named.reason);
    if (input.namedReviewerUserId === actorId) throw new ApiError('validation_failed', 'you cannot name yourself as reviewer');
    if (!(await reviewerHoldsPermission(tx, input.namedReviewerUserId))) {
      throw new ApiError('validation_failed', 'the named reviewer must be a staff member with review authority');
    }
    const t = reportTransition(r.status, 'in_review', isStaffIdentity(identity) ? 'staff' : 'partner');
    if (!t.ok) throw invalidTransition(t.message ?? 'cannot submit', { code: t.code, from: r.status });
    const [updated] = await tx
      .update(schema.reports)
      .set({ status: 'in_review', namedReviewerUserId: input.namedReviewerUserId, version: r.version + 1 })
      .where(and(eq(schema.reports.id, id), eq(schema.reports.version, r.version)))
      .returning();
    if (!updated) throw versionConflict(r.version);
    await recordAudit(tx, identity, {
      action: 'report.submitted_for_review',
      entityType: 'report',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: r.status },
      after: { status: 'in_review', namedReviewerUserId: input.namedReviewerUserId, version: r.currentVersion },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.report.review_requested',
      aggregateType: 'report',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: { projectId: r.projectId, reportId: id, reviewerUserId: input.namedReviewerUserId },
      correlationId: options.correlationId ?? null,
    });
    return toDetail(tx, identity, updated, access);
  });
}

/** Review decision (`reports.review`); the author can never review, whatever their role. */
export async function reviewReport(
  identity: RequestIdentity,
  id: string,
  input: ReportReview,
  options: ServiceOptions = {},
): Promise<ReportDetailDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, [{ staff: 'reports.review' }]);
    const notAuthor = assertNotAuthor({ authorUserId: r.createdBy, actorUserId: actorId, action: 'review' });
    if (!notAuthor.ok) throw new ApiError('forbidden', notAuthor.reason);
    assertVersion(r.version, input.expectedVersion);
    const to = reviewTransitionTarget(input.decision);
    const t = reportTransition(r.status, to, 'staff', input.note ?? null);
    if (!t.ok) throw invalidTransition(t.message ?? 'cannot review', { code: t.code, from: r.status, to });
    await tx
      .update(schema.reportRevisions)
      .set({ reviewerUserId: actorId, reviewDecision: input.decision, reviewNote: input.note ?? null, reviewedAt: new Date() })
      .where(and(eq(schema.reportRevisions.reportId, id), eq(schema.reportRevisions.version, r.currentVersion)));
    const [updated] = await tx
      .update(schema.reports)
      .set({ status: to, namedReviewerUserId: actorId, version: r.version + 1 })
      .where(and(eq(schema.reports.id, id), eq(schema.reports.version, r.version)))
      .returning();
    if (!updated) throw versionConflict(r.version);
    await recordAudit(tx, identity, {
      action: `report.review_${input.decision}`,
      entityType: 'report',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: r.status, namedReviewerUserId: r.namedReviewerUserId },
      after: { status: to, reviewerUserId: actorId, version: r.currentVersion },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.report.reviewed',
      aggregateType: 'report',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: { projectId: r.projectId, reportId: id, decision: input.decision, authorUserId: r.createdBy },
      correlationId: options.correlationId ?? null,
    });
    return toDetail(tx, identity, updated, access);
  });
}

/** approved → released (`reports.release`, never the author); the customer can now read it. */
export async function releaseReport(
  identity: RequestIdentity,
  id: string,
  input: ReportRelease,
  options: ServiceOptions = {},
): Promise<ReportDetailDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, [{ staff: 'reports.release' }]);
    const notAuthor = assertNotAuthor({ authorUserId: r.createdBy, actorUserId: actorId, action: 'release' });
    if (!notAuthor.ok) throw new ApiError('forbidden', notAuthor.reason);
    assertVersion(r.version, input.expectedVersion);
    const t = reportTransition(r.status, 'released', 'staff');
    if (!t.ok) throw invalidTransition(t.message ?? 'cannot release', { code: t.code, from: r.status });
    const [updated] = await tx
      .update(schema.reports)
      .set({
        status: 'released',
        releasedVersion: r.currentVersion,
        releasedAt: new Date(),
        releasedBy: actorId,
        customerVisible: true,
        version: r.version + 1,
      })
      .where(and(eq(schema.reports.id, id), eq(schema.reports.version, r.version)))
      .returning();
    if (!updated) throw versionConflict(r.version);
    await recordAudit(tx, identity, {
      action: 'report.released',
      entityType: 'report',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: r.status, releasedVersion: r.releasedVersion },
      after: { status: 'released', releasedVersion: r.currentVersion, releasedBy: actorId },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.report.released',
      aggregateType: 'report',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: r.projectId,
        reportId: id,
        releasedVersion: r.currentVersion,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return toDetail(tx, identity, updated, access);
  });
}

/** Evidence referenced by a report (customers: approved/redacted items only). */
export async function listReportEvidence(identity: RequestIdentity, id: string): Promise<{ items: EvidenceDto[] }> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { r, access } = await loadReport(tx, identity, id, [...PROJECT_READ_CHECKS, { org: 'org.reports.view' }]);
    const customer = isCustomerOf(identity, access);
    if (customer && !r.customerVisible) throw notFound('report');
    const rows = await tx
      .select({ e: schema.evidence, f: schema.fileObjects })
      .from(schema.evidence)
      .leftJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.evidence.fileId))
      .where(
        and(
          eq(schema.evidence.reportId, id),
          customer ? or(eq(schema.evidence.publication, 'approved'), eq(schema.evidence.publication, 'redacted_public'), eq(schema.evidence.uploaderUserId, actorId)) : undefined,
        ),
      )
      .orderBy(desc(schema.evidence.createdAt));
    return { items: rows.map((row) => toEvidenceDto(row.e, row.f)) };
  });
}

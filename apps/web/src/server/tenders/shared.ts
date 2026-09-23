import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiError,
  type BidDto,
  type BidRevisionDto,
  type BidSummaryDto,
  type TenderDto,
  type TenderInvitationDto,
  type TenderRevisionDto,
} from '@simplexd/contracts';
import { schema, type ActorContext, type DbExecutor, type Transaction } from '@simplexd/db';
import {
  assertAllowed,
  authorizeAny,
  authorizeOrg,
  authorizePartner,
  type PartnerPermission,
  type StaffPermission,
} from '@simplexd/domain/authz';
import { tenderTimelineView } from '@simplexd/domain/tenders';
import { extensionsFromRevisions, type DeadlineExtension } from '@simplexd/domain/timelines';
import type { RequestIdentity } from '@/lib/auth/session';
import { requireFeature } from '@/lib/features';

/**
 * Shared plumbing for the tendering services: feature gate, actor context,
 * the database clock, reference allocation, access resolution and DTO
 * mappers. Every service runs inside `withActor` so row-level security is the
 * second net behind the explicit checks here.
 */

export const TENDERING_FEATURE = 'expansion.contractor_tendering';

export interface ServiceOptions {
  correlationId?: string;
}

export type TenderRow = typeof schema.tenders.$inferSelect;
export type TenderRevisionRow = typeof schema.tenderRevisions.$inferSelect;
export type InvitationRow = typeof schema.tenderInvitations.$inferSelect;
export type BidRow = typeof schema.bids.$inferSelect;
export type BidRevisionRow = typeof schema.bidRevisions.$inferSelect;
export type Role = 'staff' | 'customer' | 'partner';

export function requireTendering(identity: RequestIdentity): string {
  requireFeature(identity, TENDERING_FEATURE);
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return identity.session.user.id;
}

export function ctxFor(identity: RequestIdentity, options: ServiceOptions = {}): ActorContext {
  return { ...identity.ctx, correlationId: options.correlationId ?? identity.ctx.correlationId };
}

export function isStaffIdentity(identity: RequestIdentity): boolean {
  return identity.actor.staffRoles.length > 0;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Authoritative server time from the database transaction; never the client's clock. */
export async function dbNow(tx: DbExecutor): Promise<{ date: Date; iso: string }> {
  const res = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  const raw = res.rows[0]?.now;
  const date = raw instanceof Date ? raw : new Date(raw ?? Date.now());
  return { date, iso: date.toISOString() };
}

export function versionConflict(current: number): ApiError {
  return new ApiError('version_conflict', 'this record changed since you loaded it; reload and try again', {
    details: { currentVersion: current },
  });
}

export function assertVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && current !== expected) throw versionConflict(current);
}

/**
 * Allocates the next human-readable reference (TND-2026-0001, RFQ-2026-0001,
 * PO-2026-0001). A transaction-scoped advisory lock serialises allocation per
 * prefix and year; the unique constraint on the column is the final guard.
 * Callers are staff (privileged), so the maximum spans every organisation.
 */
export async function allocateCommercialReference(
  tx: Transaction,
  table: 'tenders' | 'rfqs' | 'purchase_orders',
  prefix: 'TND' | 'RFQ' | 'PO',
  now: Date,
): Promise<string> {
  const year = now.getUTCFullYear();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`commercial-ref:${prefix}:${year}`}))`);
  const column = table === 'purchase_orders' ? sql.raw('number') : sql.raw('reference');
  const like = `${prefix}-${year}-%`;
  const res = await tx.execute<{ max: string | null }>(
    sql`SELECT max(${column}) AS max FROM ${sql.raw(table)} WHERE ${column} LIKE ${like}`,
  );
  const current = res.rows[0]?.max ?? null;
  const last = current ? Number(current.slice(current.lastIndexOf('-') + 1)) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Access resolution                                                          */
/* -------------------------------------------------------------------------- */

export interface TenderAccess {
  tender: TenderRow;
  role: Role;
  invitation: InvitationRow | null;
  revisions: TenderRevisionRow[];
  extensions: DeadlineExtension[];
}

export interface AccessOptions {
  /** Staff permissions, any of which grants access (default: tenders.manage or bids.evaluate). */
  staff?: StaffPermission[];
  /** Partner permission needed when the caller is an invited partner. */
  partner?: PartnerPermission;
  /** Whether customers of the tender's organisation may access (org.read). */
  customer?: boolean;
}

export async function loadRevisions(tx: DbExecutor, tenderId: string): Promise<TenderRevisionRow[]> {
  return tx
    .select()
    .from(schema.tenderRevisions)
    .where(eq(schema.tenderRevisions.tenderId, tenderId))
    .orderBy(asc(schema.tenderRevisions.revision));
}

export function extensionsOf(revisions: TenderRevisionRow[]): DeadlineExtension[] {
  return extensionsFromRevisions(
    revisions.map((r) => ({
      revision: r.revision,
      issuedAt: r.createdAt.toISOString(),
      changes: (r.changes as Record<string, unknown>) ?? {},
      deadlineExtendedTo: iso(r.deadlineExtendedTo),
    })),
  );
}

/**
 * Loads a tender the caller may access and decides in which role. Row-level
 * security already hides tenders the caller has no relationship with; the
 * explicit checks here decide what the relationship permits.
 */
export async function loadTenderAccess(
  tx: DbExecutor,
  identity: RequestIdentity,
  tenderId: string,
  options: AccessOptions = {},
): Promise<TenderAccess> {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const [tender] = await tx.select().from(schema.tenders).where(eq(schema.tenders.id, tenderId));
  if (!tender) throw new ApiError('not_found', 'tender not found');
  const revisions = await loadRevisions(tx, tenderId);
  const base = { tender, revisions, extensions: extensionsOf(revisions) };

  if (isStaffIdentity(identity)) {
    const perms = options.staff ?? ['tenders.manage', 'bids.evaluate'];
    assertAllowed(
      authorizeAny(
        identity.actor,
        perms.map((p) => ({ staff: p })),
        { type: 'tender', id: tender.id, organizationId: tender.organizationId },
      ),
    );
    return { ...base, role: 'staff', invitation: null };
  }

  const [invitation] = await tx
    .select()
    .from(schema.tenderInvitations)
    .where(and(eq(schema.tenderInvitations.tenderId, tenderId), eq(schema.tenderInvitations.partnerUserId, userId)));
  if (invitation && identity.actor.isPartner && tender.status !== 'draft') {
    assertAllowed(
      authorizePartner(identity.actor, options.partner ?? 'partner.tenders.view_invited', {
        type: 'tender',
        id: tender.id,
        assigneeUserIds: [userId],
      }),
    );
    return { ...base, role: 'partner', invitation };
  }

  if (options.customer !== false) {
    const decision = authorizeOrg(identity.actor, 'org.read', {
      type: 'tender',
      id: tender.id,
      organizationId: tender.organizationId,
    });
    if (decision.allowed) return { ...base, role: 'customer', invitation: null };
  }
  throw new ApiError('not_found', 'tender not found');
}

/* -------------------------------------------------------------------------- */
/* DTO mappers                                                                */
/* -------------------------------------------------------------------------- */

export function toTenderDto(row: TenderRow, revisions: TenderRevisionRow[]): TenderDto {
  const timeline = tenderTimelineView(
    {
      releaseAt: iso(row.releaseAt) ?? undefined,
      siteVisitAt: iso(row.siteVisitAt),
      questionCutoffAt: iso(row.questionCutoffAt),
      answersPublishedAt: iso(row.answersPublishedAt),
      submissionDeadlineAt: iso(row.submissionDeadlineAt) ?? undefined,
      evaluationCompleteAt: iso(row.evaluationCompleteAt),
      awardTargetAt: iso(row.awardTargetAt),
    },
    row.displayTimeZone,
    // The stored deadline already reflects extensions; revisions are kept for history/display.
    [],
  );
  const extension = extensionsOf(revisions);
  const latest = extension[extension.length - 1];
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    serviceRequestId: row.serviceRequestId,
    reference: row.reference,
    title: row.title,
    descriptionMarkdown: row.descriptionMarkdown,
    scopeFileIds: row.scopeFileIds ?? [],
    boqBudgetVersionId: row.boqBudgetVersionId,
    status: row.status,
    sealed: row.sealed,
    timeline: {
      ...timeline,
      originalSubmissionDeadlineAt: originalDeadline(row, revisions),
      extensionRevision: latest ? latest.addendumRevision : null,
    },
    displayTimeZone: row.displayTimeZone,
    currentRevision: row.currentRevision,
    evaluationWeights: row.evaluationWeights ?? {},
    partnerDisclosure: row.partnerDisclosure,
    closedAt: iso(row.closedAt),
    cancelledReason: row.cancelledReason,
    createdBy: row.createdBy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The deadline before any extension: recorded in the first extending revision's diff. */
function originalDeadline(row: TenderRow, revisions: TenderRevisionRow[]): string | null {
  for (const r of revisions) {
    const changes = r.changes as { submissionDeadlineAt?: { before?: string | null } } | null;
    const before = changes?.submissionDeadlineAt?.before;
    if (typeof before === 'string') return before;
  }
  return iso(row.submissionDeadlineAt);
}

export function toRevisionDto(row: TenderRevisionRow): TenderRevisionDto {
  return {
    id: row.id,
    tenderId: row.tenderId,
    revision: row.revision,
    changes: (row.changes as Record<string, unknown>) ?? {},
    addendumMarkdown: row.addendumMarkdown,
    deadlineExtendedTo: iso(row.deadlineExtendedTo),
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInvitationDto(row: InvitationRow, partnerName: string | null): TenderInvitationDto {
  return {
    id: row.id,
    tenderId: row.tenderId,
    partnerUserId: row.partnerUserId,
    partnerName,
    status: row.status,
    invitedBy: row.invitedBy,
    invitedAt: row.invitedAt.toISOString(),
    viewedAt: iso(row.viewedAt),
    respondedAt: iso(row.respondedAt),
  };
}

export function toBidRevisionDto(row: BidRevisionRow): BidRevisionDto {
  return {
    version: row.version,
    amountKobo: row.amountKobo.toString(),
    currency: row.currency,
    lineItems: (row.lineItems as BidRevisionDto['lineItems']) ?? [],
    durationDays: row.durationDays,
    qualifications: (row.qualifications as Record<string, unknown>) ?? {},
    attachmentFileIds: row.attachmentFileIds ?? [],
    submittedAt: iso(row.submittedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Sealed view: existence, partner and submission time; never amounts or revisions. */
export function toSealedBidSummary(row: BidRow, partnerName: string | null): BidSummaryDto {
  return {
    id: row.id,
    tenderId: row.tenderId,
    partnerUserId: row.partnerUserId,
    partnerName,
    status: row.status,
    currentVersion: row.currentVersion,
    submittedAt: iso(row.submittedAt),
    withdrawnAt: iso(row.withdrawnAt),
    sealed: true,
    openedAt: null,
    version: row.version,
  };
}

/** Existence derived from the invitation while row-level security still hides the bid row itself. */
export function toInvitationBidSummary(inv: InvitationRow, partnerName: string | null): BidSummaryDto {
  return {
    id: null,
    tenderId: inv.tenderId,
    partnerUserId: inv.partnerUserId,
    partnerName,
    status: 'submitted',
    currentVersion: null,
    submittedAt: iso(inv.respondedAt),
    withdrawnAt: null,
    sealed: true,
    openedAt: null,
    version: null,
  };
}

export function toBidDto(row: BidRow, revisions: BidRevisionRow[], partnerName: string | null): BidDto {
  const sorted = [...revisions].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1] ?? null;
  return {
    id: row.id,
    tenderId: row.tenderId,
    partnerUserId: row.partnerUserId,
    partnerName,
    status: row.status,
    currentVersion: row.currentVersion,
    submittedAt: iso(row.submittedAt),
    withdrawnAt: iso(row.withdrawnAt),
    sealed: false,
    openedAt: iso(row.openedAt),
    openedBy: row.openedBy,
    openReason: row.openReason,
    version: row.version,
    revisions: sorted.map(toBidRevisionDto),
    latestRevision: latest ? toBidRevisionDto(latest) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function userNames(tx: DbExecutor, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function loadBidRevisions(tx: DbExecutor, bidIds: string[]): Promise<Map<string, BidRevisionRow[]>> {
  const out = new Map<string, BidRevisionRow[]>();
  if (bidIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(schema.bidRevisions)
    .where(inArray(schema.bidRevisions.bidId, bidIds))
    .orderBy(asc(schema.bidRevisions.version));
  for (const r of rows) {
    const list = out.get(r.bidId) ?? [];
    list.push(r);
    out.set(r.bidId, list);
  }
  return out;
}

/** Every read of sealed-bid content by staff or a customer is logged (privileged-only, append-only table). */
export async function logBidAccess(
  tx: DbExecutor,
  bidIds: string[],
  userId: string,
  action: 'open' | 'read' | 'evaluate',
  reason: string | null = null,
): Promise<void> {
  if (bidIds.length === 0) return;
  await tx.insert(schema.bidAccessLog).values(bidIds.map((bidId) => ({ bidId, userId, action, reason })));
}

/** Latest submitted revision (by version) of a bid. */
export function latestSubmittedRevision(revisions: BidRevisionRow[]): BidRevisionRow | null {
  const submitted = revisions.filter((r) => r.submittedAt !== null).sort((a, b) => b.version - a.version);
  return submitted[0] ?? null;
}

export const orderNewestFirst = [desc(schema.tenders.createdAt), desc(schema.tenders.id)];

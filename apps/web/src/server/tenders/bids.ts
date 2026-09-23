import 'server-only';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type BidDto,
  type BidReadDto,
  type BidRevisionInput,
  type BidSubmit,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeStaff } from '@simplexd/domain/authz';
import { submissionDecision } from '@simplexd/domain/tenders';
import { bidMachine, evaluateTransition } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, demote, elevate, encodeCursor } from '@/server/portal/elevate';
import {
  assertVersion,
  ctxFor,
  dbNow,
  iso,
  isStaffIdentity,
  loadBidRevisions,
  loadTenderAccess,
  logBidAccess,
  requireTendering,
  toBidDto,
  toInvitationBidSummary,
  toSealedBidSummary,
  userNames,
  type BidRow,
  type ServiceOptions,
  type TenderAccess,
  type TenderRow,
} from './shared';

/**
 * Sealed bids. A partner drafts, revises, submits and withdraws only while
 * the server clock (the database transaction's now()) is before the
 * effective deadline. Nobody but the bidder sees a bid's content until the
 * tender is closed and a staff member with bids.open_sealed opens the bids
 * with a reason; every later read by staff or a customer is logged.
 */

const OPEN_STATUSES: ReadonlySet<TenderRow['status']> = new Set(['published', 'clarifications']);
const POST_CLOSE: ReadonlySet<TenderRow['status']> = new Set(['closed', 'evaluating', 'awarded']);

interface OwnBid {
  access: TenderAccess;
  bid: BidRow;
}

async function loadOwnBid(tx: DbExecutor, identity: RequestIdentity, bidId: string): Promise<OwnBid> {
  const userId = identity.session!.user.id;
  const [bid] = await tx.select().from(schema.bids).where(eq(schema.bids.id, bidId));
  if (!bid || bid.partnerUserId !== userId) throw new ApiError('not_found', 'bid not found');
  const access = await loadTenderAccess(tx, identity, bid.tenderId, { partner: 'partner.bids.submit', customer: false });
  if (access.role !== 'partner') throw new ApiError('not_found', 'bid not found');
  return { access, bid };
}

async function assertSubmissionOpen(tx: DbExecutor, tender: TenderRow, clientClaimedTime?: string | null): Promise<string> {
  const now = await dbNow(tx);
  if (!OPEN_STATUSES.has(tender.status)) {
    throw new ApiError('deadline_passed', 'the tender is no longer accepting submissions', {
      details: { status: tender.status, serverNow: now.iso },
    });
  }
  const decision = submissionDecision({
    now: now.iso,
    submissionDeadlineAt: iso(tender.submissionDeadlineAt) ?? '',
    clientClaimedTime: clientClaimedTime ?? null,
  });
  if (!decision.allowed) {
    throw new ApiError('deadline_passed', 'the submission deadline has passed', {
      details: { reason: decision.reason, effectiveDeadlineAt: decision.effectiveDeadlineAt, serverNow: now.iso, clientClaimedTime: clientClaimedTime ?? null },
    });
  }
  return now.iso;
}

async function assertOwnAttachments(tx: DbExecutor, userId: string, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const files = await tx
    .select({ id: schema.fileObjects.id })
    .from(schema.fileObjects)
    .where(and(inArray(schema.fileObjects.id, fileIds), eq(schema.fileObjects.ownerUserId, userId)));
  if (files.length !== new Set(fileIds).size) {
    throw new ApiError('validation_failed', 'every attachment must be a file you uploaded', { details: { field: 'attachmentFileIds' } });
  }
}

async function bidDtoInTx(tx: DbExecutor, bid: BidRow, partnerName: string | null): Promise<BidDto> {
  const revisions = (await loadBidRevisions(tx, [bid.id])).get(bid.id) ?? [];
  return toBidDto(bid, revisions, partnerName);
}

/* -------------------------------------------------------------------------- */
/* Partner actions                                                            */
/* -------------------------------------------------------------------------- */

/** Creates (or returns) the caller's draft bid on a tender they were invited to. */
export async function createBid(identity: RequestIdentity, tenderId: string, options: ServiceOptions = {}): Promise<BidDto> {
  const userId = requireTendering(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { partner: 'partner.bids.submit', customer: false });
    if (access.role !== 'partner' || !access.invitation) throw new ApiError('forbidden', 'only invited partners bid');
    if (access.invitation.status === 'declined') throw new ApiError('invalid_transition', 'the invitation was declined');
    await assertSubmissionOpen(tx, access.tender);
    const [existing] = await tx
      .select()
      .from(schema.bids)
      .where(and(eq(schema.bids.tenderId, tenderId), eq(schema.bids.partnerUserId, userId)));
    if (existing) {
      if (existing.status === 'withdrawn') throw new ApiError('conflict', 'a withdrawn bid cannot be reopened');
      return bidDtoInTx(tx, existing, identity.session?.user.name ?? null);
    }
    const [row] = await tx.insert(schema.bids).values({ tenderId, partnerUserId: userId, status: 'draft' }).returning();
    const bid = row!;
    await recordAudit(tx, identity, {
      action: 'bid.created',
      entityType: 'bid',
      entityId: bid.id,
      organizationId: access.tender.organizationId,
      after: { tenderId },
      correlationId: options.correlationId,
    });
    return toBidDto(bid, [], identity.session?.user.name ?? null);
  });
}

/** Adds an unsubmitted revision (content) to the caller's bid; nothing is visible to anyone else. */
export async function addBidRevision(
  identity: RequestIdentity,
  bidId: string,
  input: BidRevisionInput,
  options: ServiceOptions = {},
): Promise<BidDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access, bid } = await loadOwnBid(tx, identity, bidId);
    if (bid.status !== 'draft' && bid.status !== 'submitted') {
      throw new ApiError('invalid_transition', `a ${bid.status} bid cannot be revised`);
    }
    await assertSubmissionOpen(tx, access.tender);
    await assertOwnAttachments(tx, userId, input.attachmentFileIds);
    const revisions = (await loadBidRevisions(tx, [bid.id])).get(bid.id) ?? [];
    const version = (revisions[revisions.length - 1]?.version ?? 0) + 1;
    await tx.insert(schema.bidRevisions).values({
      bidId,
      version,
      amountKobo: BigInt(input.amountKobo),
      currency: input.currency,
      lineItems: input.lineItems,
      durationDays: input.durationDays ?? null,
      qualifications: input.qualifications,
      attachmentFileIds: input.attachmentFileIds,
      submittedAt: null,
    });
    await recordAudit(tx, identity, {
      action: 'bid.revision_added',
      entityType: 'bid',
      entityId: bidId,
      organizationId: access.tender.organizationId,
      after: { version, submitted: false },
      correlationId: options.correlationId,
    });
    return bidDtoInTx(tx, bid, identity.session?.user.name ?? null);
  });
}

/**
 * Submits a bid: a new revision row is written with submittedAt = the
 * database clock (revisions are append-only, so a draft revision is copied
 * rather than flagged). The update of the bid row re-checks the deadline in
 * SQL so a stale client can never slip past it.
 */
export async function submitBid(
  identity: RequestIdentity,
  bidId: string,
  input: BidSubmit,
  options: ServiceOptions = {},
): Promise<BidDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access, bid } = await loadOwnBid(tx, identity, bidId);
    assertVersion(bid.version, input.expectedVersion);
    const decision = evaluateTransition(bidMachine, { from: bid.status, to: 'submitted', actor: 'partner' });
    if (!decision.ok) throw new ApiError('invalid_transition', decision.message, { details: { code: decision.code } });
    const nowIso = await assertSubmissionOpen(tx, access.tender, input.clientClaimedTime);
    const revisions = (await loadBidRevisions(tx, [bid.id])).get(bid.id) ?? [];
    const version = (revisions[revisions.length - 1]?.version ?? 0) + 1;
    let content: BidRevisionInput;
    if (input.revision) {
      content = input.revision;
    } else {
      const latest = revisions[revisions.length - 1];
      if (!latest) throw new ApiError('validation_failed', 'add bid content before submitting');
      content = {
        amountKobo: latest.amountKobo.toString(),
        currency: latest.currency,
        lineItems: (latest.lineItems as BidRevisionInput['lineItems']) ?? [],
        durationDays: latest.durationDays,
        qualifications: (latest.qualifications as Record<string, unknown>) ?? {},
        attachmentFileIds: latest.attachmentFileIds ?? [],
      };
    }
    await assertOwnAttachments(tx, userId, content.attachmentFileIds);
    const now = new Date(nowIso);
    // Atomic: the row only changes if the tender is still open on the database clock.
    const updated = await tx
      .update(schema.bids)
      .set({ status: 'submitted', currentVersion: version, submittedAt: now, version: bid.version + 1 })
      .where(
        and(
          eq(schema.bids.id, bidId),
          eq(schema.bids.version, bid.version),
          sql`EXISTS (SELECT 1 FROM tenders t WHERE t.id = ${schema.bids.tenderId} AND t.status IN ('published','clarifications') AND now() < t.submission_deadline_at)`,
        ),
      )
      .returning({ id: schema.bids.id });
    if (updated.length === 0) {
      throw new ApiError('deadline_passed', 'the submission deadline has passed', { details: { serverNow: nowIso } });
    }
    await tx.insert(schema.bidRevisions).values({
      bidId,
      version,
      amountKobo: BigInt(content.amountKobo),
      currency: content.currency,
      lineItems: content.lineItems,
      durationDays: content.durationDays ?? null,
      qualifications: content.qualifications,
      attachmentFileIds: content.attachmentFileIds,
      submittedAt: now,
    });
    await tx
      .update(schema.tenderInvitations)
      .set({ status: 'submitted', respondedAt: now })
      .where(and(eq(schema.tenderInvitations.tenderId, bid.tenderId), eq(schema.tenderInvitations.partnerUserId, userId)));
    await appendOutbox(tx, {
      eventType: 'bid.submitted',
      aggregateType: 'bid',
      aggregateId: bidId,
      organizationId: access.tender.organizationId,
      actorUserId: userId,
      payload: { tenderId: bid.tenderId, bidId, version },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'bid.submitted',
      entityType: 'bid',
      entityId: bidId,
      organizationId: access.tender.organizationId,
      before: { status: bid.status, currentVersion: bid.currentVersion },
      after: { status: 'submitted', currentVersion: version, submittedAt: nowIso, clientClaimedTime: input.clientClaimedTime ?? null },
      correlationId: options.correlationId,
    });
    const [fresh] = await tx.select().from(schema.bids).where(eq(schema.bids.id, bidId));
    return bidDtoInTx(tx, fresh!, identity.session?.user.name ?? null);
  });
}

export async function withdrawBid(
  identity: RequestIdentity,
  bidId: string,
  input: { reason: string; expectedVersion?: number },
  options: ServiceOptions = {},
): Promise<BidDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access, bid } = await loadOwnBid(tx, identity, bidId);
    assertVersion(bid.version, input.expectedVersion);
    const decision = evaluateTransition(bidMachine, { from: bid.status, to: 'withdrawn', actor: 'partner', reason: input.reason });
    if (!decision.ok) throw new ApiError('invalid_transition', decision.message, { details: { code: decision.code } });
    const nowIso = await assertSubmissionOpen(tx, access.tender);
    const now = new Date(nowIso);
    const updated = await tx
      .update(schema.bids)
      .set({ status: 'withdrawn', withdrawnAt: now, version: bid.version + 1 })
      .where(
        and(
          eq(schema.bids.id, bidId),
          eq(schema.bids.version, bid.version),
          sql`EXISTS (SELECT 1 FROM tenders t WHERE t.id = ${schema.bids.tenderId} AND t.status IN ('published','clarifications') AND now() < t.submission_deadline_at)`,
        ),
      )
      .returning();
    if (updated.length === 0) throw new ApiError('deadline_passed', 'the submission deadline has passed');
    await tx
      .update(schema.tenderInvitations)
      .set({ status: 'viewed', respondedAt: now })
      .where(and(eq(schema.tenderInvitations.tenderId, bid.tenderId), eq(schema.tenderInvitations.partnerUserId, userId)));
    await recordAudit(tx, identity, {
      action: 'bid.withdrawn',
      entityType: 'bid',
      entityId: bidId,
      organizationId: access.tender.organizationId,
      before: { status: bid.status },
      after: { status: 'withdrawn' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return bidDtoInTx(tx, updated[0]!, identity.session?.user.name ?? null);
  });
}

/* -------------------------------------------------------------------------- */
/* Reads with the sealing rule                                                */
/* -------------------------------------------------------------------------- */

function customerMayReadContent(tender: TenderRow): boolean {
  return POST_CLOSE.has(tender.status);
}

/**
 * Reads bids of a tender for a staff member or customer. Before the bids are
 * opened only existence, partner and submission time are returned. Customers
 * see nothing before the tender closes. Row-level security hides bid rows
 * from staff before the deadline and from customers always, so the customer
 * read after opening runs elevated once the checks have passed, and every
 * content read is logged.
 */
async function readTenderBidsForReviewer(
  tx: Transaction,
  identity: RequestIdentity,
  access: TenderAccess,
  ctx: ReturnType<typeof ctxFor>,
): Promise<BidReadDto[]> {
  const userId = identity.session!.user.id;
  const { tender } = access;
  if (access.role === 'customer' && !customerMayReadContent(tender)) return [];
  const invitations = await tx
    .select()
    .from(schema.tenderInvitations)
    .where(eq(schema.tenderInvitations.tenderId, tender.id));
  const names = await userNames(tx, invitations.map((i) => i.partnerUserId));

  let bids: BidRow[] = [];
  const elevated = access.role === 'customer';
  if (elevated) await elevate(tx, ctx);
  try {
    bids = await tx.select().from(schema.bids).where(eq(schema.bids.tenderId, tender.id));
    const opened = bids.filter((b) => b.openedAt !== null && b.status !== 'draft');
    const sealed = bids.filter((b) => b.openedAt === null && b.status !== 'draft');
    const revisions = await loadBidRevisions(tx, opened.map((b) => b.id));
    await logBidAccess(tx, opened.map((b) => b.id), userId, 'read');
    const out: BidReadDto[] = [
      ...opened.map((b) => toBidDto(b, revisions.get(b.id) ?? [], names.get(b.partnerUserId) ?? null)),
      ...sealed.map((b) => toSealedBidSummary(b, names.get(b.partnerUserId) ?? null)),
    ];
    // Before the deadline row-level security hides the bid rows; existence comes from the invitations.
    const seen = new Set(bids.map((b) => b.partnerUserId));
    for (const inv of invitations) {
      if (inv.status === 'submitted' && !seen.has(inv.partnerUserId)) {
        out.push(toInvitationBidSummary(inv, names.get(inv.partnerUserId) ?? null));
      }
    }
    return out;
  } finally {
    if (elevated) await demote(tx, ctx);
  }
}

export async function listTenderBids(identity: RequestIdentity, tenderId: string, options: ServiceOptions = {}): Promise<BidReadDto[]> {
  const userId = requireTendering(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { partner: 'partner.bids.submit' });
    if (access.role === 'partner') {
      const [bid] = await tx
        .select()
        .from(schema.bids)
        .where(and(eq(schema.bids.tenderId, tenderId), eq(schema.bids.partnerUserId, userId)));
      return bid ? [await bidDtoInTx(tx, bid, identity.session?.user.name ?? null)] : [];
    }
    return readTenderBidsForReviewer(tx, identity, access, ctx);
  });
}

export async function getBid(identity: RequestIdentity, bidId: string, options: ServiceOptions = {}): Promise<BidReadDto> {
  const userId = requireTendering(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    if (isStaffIdentity(identity)) {
      const [bid] = await tx.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      if (!bid) throw new ApiError('not_found', 'bid not found');
      const access = await loadTenderAccess(tx, identity, bid.tenderId);
      const names = await userNames(tx, [bid.partnerUserId]);
      const name = names.get(bid.partnerUserId) ?? null;
      if (!bid.openedAt || access.tender.status === 'draft') return toSealedBidSummary(bid, name);
      await logBidAccess(tx, [bid.id], userId, 'read');
      return bidDtoInTx(tx, bid, name);
    }
    // Partner: row-level security only returns the caller's own bid.
    const [own] = await tx.select().from(schema.bids).where(and(eq(schema.bids.id, bidId), eq(schema.bids.partnerUserId, userId)));
    if (own) {
      await loadTenderAccess(tx, identity, own.tenderId, { partner: 'partner.bids.submit', customer: false });
      return bidDtoInTx(tx, own, identity.session?.user.name ?? null);
    }
    // Customer: only after the tender closed and the bids were opened.
    const tenderRow = await tx.execute<{ tender_id: string }>(
      sql`SELECT t.id AS tender_id FROM tenders t WHERE EXISTS (SELECT 1 FROM bids b WHERE b.id = ${bidId} AND b.tender_id = t.id)`,
    );
    const tenderId = tenderRow.rows[0]?.tender_id;
    if (!tenderId) throw new ApiError('not_found', 'bid not found');
    const access = await loadTenderAccess(tx, identity, tenderId);
    if (access.role !== 'customer' || !customerMayReadContent(access.tender)) throw new ApiError('not_found', 'bid not found');
    const all = await readTenderBidsForReviewer(tx, identity, access, ctx);
    const found = all.find((b) => b.id === bidId);
    if (!found) throw new ApiError('not_found', 'bid not found');
    return found;
  });
}

/* -------------------------------------------------------------------------- */
/* Opening sealed bids                                                        */
/* -------------------------------------------------------------------------- */

export async function openBidsInTx(
  tx: DbExecutor,
  identity: RequestIdentity,
  access: TenderAccess,
  reason: string,
  options: ServiceOptions,
): Promise<string[]> {
  const userId = identity.session!.user.id;
  assertAllowed(authorizeStaff(identity.actor, 'bids.open_sealed', { type: 'tender', id: access.tender.id, organizationId: access.tender.organizationId }));
  if (!POST_CLOSE.has(access.tender.status)) {
    throw new ApiError('invalid_transition', 'sealed bids can only be opened after the tender closes', {
      details: { status: access.tender.status },
    });
  }
  const now = await dbNow(tx);
  const opened = await tx
    .update(schema.bids)
    .set({ openedAt: now.date, openedBy: userId, openReason: reason })
    .where(and(eq(schema.bids.tenderId, access.tender.id), sql`${schema.bids.openedAt} IS NULL`, sql`${schema.bids.status} <> 'draft'`))
    .returning({ id: schema.bids.id });
  const ids = opened.map((o) => o.id);
  await logBidAccess(tx, ids, userId, 'open', reason);
  if (ids.length > 0) {
    await appendOutbox(tx, {
      eventType: 'tender.bids_opened',
      aggregateType: 'tender',
      aggregateId: access.tender.id,
      organizationId: access.tender.organizationId,
      actorUserId: userId,
      payload: { tenderId: access.tender.id, bidIds: ids },
      correlationId: options.correlationId,
    });
  }
  await recordAudit(tx, identity, {
    action: 'tender.bids_opened',
    entityType: 'tender',
    entityId: access.tender.id,
    organizationId: access.tender.organizationId,
    after: { bidIds: ids, openedAt: now.iso },
    reason,
    correlationId: options.correlationId,
  });
  return ids;
}

/** Explicit, audited opening of the sealed bids (bids.open_sealed, MFA). */
export async function openTenderBids(
  identity: RequestIdentity,
  tenderId: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<BidReadDto[]> {
  requireTendering(identity);
  const ctx = ctxFor(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { staff: ['bids.open_sealed'], customer: false });
    await openBidsInTx(tx, identity, access, input.reason, options);
    return readTenderBidsForReviewer(tx, identity, access, ctx);
  });
}

/* -------------------------------------------------------------------------- */
/* Partner workspace                                                          */
/* -------------------------------------------------------------------------- */

export interface MyBidDto extends BidDto {
  tenderReference: string;
  tenderTitle: string;
  tenderStatus: TenderRow['status'];
}

export async function listMyBids(
  identity: RequestIdentity,
  query: { cursor?: string; limit: number; status?: BidRow['status'] },
  options: ServiceOptions = {},
): Promise<Page<MyBidDto>> {
  const userId = requireTendering(identity);
  if (!identity.actor.isPartner) throw new ApiError('forbidden', 'partner account required');
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const rows = await tx
      .select({ bid: schema.bids, tender: schema.tenders })
      .from(schema.bids)
      .innerJoin(schema.tenders, eq(schema.tenders.id, schema.bids.tenderId))
      .where(
        and(
          eq(schema.bids.partnerUserId, userId),
          query.status ? eq(schema.bids.status, query.status) : undefined,
          cursor
            ? or(lt(schema.bids.createdAt, cursor.createdAt), and(eq(schema.bids.createdAt, cursor.createdAt), lt(schema.bids.id, cursor.id)))
            : undefined,
        ),
      )
      .orderBy(desc(schema.bids.createdAt), desc(schema.bids.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const revisions = await loadBidRevisions(tx, page.map((r) => r.bid.id));
    const name = identity.session?.user.name ?? null;
    const items = page.map((r) => ({
      ...toBidDto(r.bid, revisions.get(r.bid.id) ?? [], name),
      tenderReference: r.tender.reference,
      tenderTitle: r.tender.title,
      tenderStatus: r.tender.status,
    }));
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.bid.createdAt, last.bid.id) : null };
  });
}

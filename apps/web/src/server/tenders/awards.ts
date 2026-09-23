import 'server-only';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { ApiError, type AwardDto, type AwardOutcomeDto, type Page } from '@simplexd/contracts';
import { appendOutbox, enqueueJob, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { bidMachine, evaluateTransition, tenderMachine } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor } from '@/server/portal/elevate';
import {
  assertVersion,
  ctxFor,
  dbNow,
  iso,
  latestSubmittedRevision,
  loadBidRevisions,
  loadTenderAccess,
  requireTendering,
  userNames,
  type ServiceOptions,
  type TenderRow,
} from './shared';

/**
 * Award: decided (staff only), published (partners learn the outcome; the
 * winner sees the award, the others only that they were unsuccessful),
 * accepted or declined by the winner. Row-level security shows partners an
 * award row only once published; before that the endpoint answers not found.
 */

type AwardRow = typeof schema.awards.$inferSelect;

function toAwardDto(
  award: AwardRow,
  tender: TenderRow,
  partnerUserId: string,
  partnerName: string | null,
  currency: string,
): AwardDto {
  return {
    id: award.id,
    tenderId: award.tenderId,
    tenderReference: tender.reference,
    tenderTitle: tender.title,
    bidId: award.bidId,
    partnerUserId,
    partnerName,
    status: award.status,
    contractValueKobo: award.contractValueKobo === null ? null : award.contractValueKobo.toString(),
    currency,
    decidedBy: award.decidedBy,
    decidedAt: award.decidedAt.toISOString(),
    publishedAt: iso(award.publishedAt),
    publishedBy: award.publishedBy,
    notes: award.notes,
    respondedAt: iso(award.respondedAt),
  };
}

async function awardWithBid(
  tx: DbExecutor,
  tender: TenderRow,
): Promise<{
  award: AwardRow;
  bid: typeof schema.bids.$inferSelect;
  currency: string;
  partnerName: string | null;
} | null> {
  const [award] = await tx
    .select()
    .from(schema.awards)
    .where(eq(schema.awards.tenderId, tender.id));
  if (!award) return null;
  const [bid] = await tx.select().from(schema.bids).where(eq(schema.bids.id, award.bidId));
  if (!bid) return null;
  const latest = latestSubmittedRevision((await loadBidRevisions(tx, [bid.id])).get(bid.id) ?? []);
  const names = await userNames(tx, [bid.partnerUserId]);
  return {
    award,
    bid,
    currency: latest?.currency ?? 'NGN',
    partnerName: names.get(bid.partnerUserId) ?? null,
  };
}

/** A partner's outcome from the award row alone (row-level security hides competitors' bids). */
async function partnerOutcome(
  tx: DbExecutor,
  identity: RequestIdentity,
  tender: TenderRow,
  own: typeof schema.bids.$inferSelect,
): Promise<AwardOutcomeDto | null> {
  const [award] = await tx
    .select()
    .from(schema.awards)
    .where(eq(schema.awards.tenderId, tender.id));
  if (!award || !award.publishedAt) return null;
  const isWinner = award.bidId === own.id;
  const latest = latestSubmittedRevision((await loadBidRevisions(tx, [own.id])).get(own.id) ?? []);
  return {
    tenderId: tender.id,
    tenderReference: tender.reference,
    tenderTitle: tender.title,
    outcome: isWinner ? 'awarded' : 'unsuccessful',
    publishedAt: award.publishedAt.toISOString(),
    bidStatus: own.status,
    award: isWinner
      ? toAwardDto(
          award,
          tender,
          own.partnerUserId,
          identity.session?.user.name ?? null,
          latest?.currency ?? 'NGN',
        )
      : null,
  };
}

export async function decideAward(
  identity: RequestIdentity,
  tenderId: string,
  input: { bidId: string; notes?: string | null; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<AwardDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, {
      staff: ['tenders.manage'],
      customer: false,
    });
    const { tender } = access;
    assertVersion(tender.version, input.expectedVersion);
    if (tender.status !== 'evaluating') {
      throw new ApiError(
        'invalid_transition',
        'an award is decided while the tender is evaluating',
        { details: { status: tender.status } },
      );
    }
    const [bid] = await tx
      .select()
      .from(schema.bids)
      .where(and(eq(schema.bids.id, input.bidId), eq(schema.bids.tenderId, tenderId)));
    if (!bid) throw new ApiError('not_found', 'bid not found on this tender');
    if (bid.status !== 'evaluated') {
      throw new ApiError('invalid_transition', 'only an evaluated bid can be awarded', {
        details: { status: bid.status },
      });
    }
    const latest = latestSubmittedRevision(
      (await loadBidRevisions(tx, [bid.id])).get(bid.id) ?? [],
    );
    if (!latest) throw new ApiError('invalid_transition', 'the bid has no submitted revision');
    const [existing] = await tx
      .select({ id: schema.awards.id })
      .from(schema.awards)
      .where(eq(schema.awards.tenderId, tenderId));
    if (existing)
      throw new ApiError('conflict', 'an award has already been decided for this tender');
    const [award] = await tx
      .insert(schema.awards)
      .values({
        tenderId,
        bidId: bid.id,
        status: 'decided',
        contractValueKobo: latest.amountKobo,
        decidedBy: userId,
        notes: input.notes ?? null,
      })
      .returning();
    await tx
      .update(schema.tenders)
      .set({ version: tender.version + 1 })
      .where(eq(schema.tenders.id, tenderId));
    await recordAudit(tx, identity, {
      action: 'tender.award_decided',
      entityType: 'award',
      entityId: award!.id,
      organizationId: tender.organizationId,
      after: { tenderId, bidId: bid.id, contractValueKobo: latest.amountKobo.toString() },
      correlationId: options.correlationId,
    });
    const names = await userNames(tx, [bid.partnerUserId]);
    return toAwardDto(
      award!,
      tender,
      bid.partnerUserId,
      names.get(bid.partnerUserId) ?? null,
      latest.currency,
    );
  });
}

export async function publishAward(
  identity: RequestIdentity,
  tenderId: string,
  input: { expectedVersion: number },
  options: ServiceOptions = {},
): Promise<AwardDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, {
      staff: ['tenders.manage'],
      customer: false,
    });
    const { tender } = access;
    assertVersion(tender.version, input.expectedVersion);
    const found = await awardWithBid(tx, tender);
    if (!found) throw new ApiError('not_found', 'no award has been decided');
    if (found.award.status !== 'decided')
      throw new ApiError('invalid_transition', 'the award is already published');
    const transition = evaluateTransition(tenderMachine, {
      from: tender.status,
      to: 'awarded',
      actor: 'staff',
    });
    if (!transition.ok)
      throw new ApiError('invalid_transition', transition.message, {
        details: { code: transition.code },
      });
    const win = evaluateTransition(bidMachine, {
      from: found.bid.status,
      to: 'awarded',
      actor: 'staff',
    });
    if (!win.ok) throw new ApiError('invalid_transition', win.message);
    const now = await dbNow(tx);
    const [award] = await tx
      .update(schema.awards)
      .set({ status: 'published', publishedAt: now.date, publishedBy: userId })
      .where(eq(schema.awards.id, found.award.id))
      .returning();
    await tx.update(schema.bids).set({ status: 'awarded' }).where(eq(schema.bids.id, found.bid.id));
    const losers = await tx
      .update(schema.bids)
      .set({ status: 'unsuccessful' })
      .where(and(eq(schema.bids.tenderId, tenderId), eq(schema.bids.status, 'evaluated')))
      .returning({ id: schema.bids.id, partnerUserId: schema.bids.partnerUserId });
    const [updated] = await tx
      .update(schema.tenders)
      .set({ status: 'awarded', version: tender.version + 1 })
      .where(and(eq(schema.tenders.id, tenderId), eq(schema.tenders.version, tender.version)))
      .returning({ id: schema.tenders.id });
    if (!updated) throw new ApiError('version_conflict', 'tender changed concurrently');
    const recipients = [found.bid.partnerUserId, ...losers.map((l) => l.partnerUserId)];
    await appendOutbox(tx, {
      eventType: 'tender.award.published',
      aggregateType: 'tender',
      aggregateId: tenderId,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: {
        tenderId,
        awardId: award!.id,
        winnerUserId: found.bid.partnerUserId,
        recipientUserIds: recipients,
      },
      correlationId: options.correlationId,
    });
    await enqueueJob(tx, {
      type: 'tenders.notify_award',
      queue: 'notifications',
      payload: { tenderId, awardId: award!.id, recipientUserIds: recipients },
      organizationId: tender.organizationId,
      actorUserId: userId,
      dedupeKey: `tenders.notify_award:${award!.id}`,
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.award_published',
      entityType: 'award',
      entityId: award!.id,
      organizationId: tender.organizationId,
      before: { status: 'decided', tenderStatus: tender.status },
      after: {
        status: 'published',
        tenderStatus: 'awarded',
        unsuccessfulBidIds: losers.map((l) => l.id),
      },
      correlationId: options.correlationId,
    });
    return toAwardDto(award!, tender, found.bid.partnerUserId, found.partnerName, found.currency);
  });
}

/**
 * Staff and customers read the award record (customers only once published,
 * which row-level security enforces). Partners get an outcome: the winner
 * sees the award; an unsuccessful bidder learns only that. Before
 * publication partners always get not found.
 */
export async function getAward(
  identity: RequestIdentity,
  tenderId: string,
  options: ServiceOptions = {},
): Promise<AwardDto | AwardOutcomeDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId);
    const { tender } = access;
    if (access.role === 'partner') {
      const [own] = await tx
        .select()
        .from(schema.bids)
        .where(and(eq(schema.bids.tenderId, tenderId), eq(schema.bids.partnerUserId, userId)));
      if (!own || tender.status !== 'awarded') throw new ApiError('not_found', 'award not found');
      const outcome = await partnerOutcome(tx, identity, tender, own);
      if (!outcome) throw new ApiError('not_found', 'award not found');
      return outcome;
    }
    const found = await awardWithBid(tx, tender);
    if (!found) throw new ApiError('not_found', 'award not found');
    if (access.role === 'customer' && !found.award.publishedAt)
      throw new ApiError('not_found', 'award not found');
    return toAwardDto(
      found.award,
      tender,
      found.bid.partnerUserId,
      found.partnerName,
      found.currency,
    );
  });
}

export async function respondToAward(
  identity: RequestIdentity,
  tenderId: string,
  input: { decision: 'accept' | 'decline'; note?: string | null },
  options: ServiceOptions = {},
): Promise<AwardDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { customer: false });
    if (access.role !== 'partner')
      throw new ApiError('forbidden', 'only the awarded partner responds');
    const found = await awardWithBid(tx, access.tender);
    if (!found || !found.award.publishedAt || found.bid.partnerUserId !== userId)
      throw new ApiError('not_found', 'award not found');
    if (found.award.status !== 'published')
      throw new ApiError('invalid_transition', `the award is already ${found.award.status}`);
    const now = await dbNow(tx);
    const [award] = await tx
      .update(schema.awards)
      .set({ status: input.decision === 'accept' ? 'accepted' : 'declined', respondedAt: now.date })
      .where(eq(schema.awards.id, found.award.id))
      .returning();
    await appendOutbox(tx, {
      eventType: 'tender.award.responded',
      aggregateType: 'tender',
      aggregateId: tenderId,
      organizationId: access.tender.organizationId,
      actorUserId: userId,
      payload: { tenderId, awardId: award!.id, decision: input.decision },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: `tender.award_${input.decision === 'accept' ? 'accepted' : 'declined'}`,
      entityType: 'award',
      entityId: award!.id,
      organizationId: access.tender.organizationId,
      before: { status: 'published' },
      after: { status: award!.status, note: input.note ?? null },
      correlationId: options.correlationId,
    });
    return toAwardDto(
      award!,
      access.tender,
      userId,
      identity.session?.user.name ?? null,
      found.currency,
    );
  });
}

/** Partner workspace: outcomes of every published award on tenders the caller bid on. */
export async function listMyAwards(
  identity: RequestIdentity,
  query: { cursor?: string; limit: number },
  options: ServiceOptions = {},
): Promise<Page<AwardOutcomeDto>> {
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
          eq(schema.tenders.status, 'awarded'),
          inArray(schema.bids.status, [
            'awarded',
            'unsuccessful',
            'evaluated',
            'submitted',
            'disqualified',
          ]),
          cursor
            ? or(
                lt(schema.tenders.createdAt, cursor.createdAt),
                and(
                  eq(schema.tenders.createdAt, cursor.createdAt),
                  lt(schema.tenders.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.tenders.createdAt), desc(schema.tenders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items: AwardOutcomeDto[] = [];
    for (const r of page) {
      const outcome = await partnerOutcome(tx, identity, r.tender, r.bid);
      if (outcome) items.push(outcome);
    }
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.tender.createdAt, last.tender.id) : null };
  });
}

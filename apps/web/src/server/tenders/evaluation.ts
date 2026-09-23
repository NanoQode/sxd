import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type BidEvaluationDto,
  type BidEvaluationInput,
  type TenderComparisonDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { aggregateWeightedScores, rankBids, weightedScore } from '@simplexd/domain/tenders';
import { bidMachine, evaluateTransition, tenderMachine } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { openBidsInTx } from './bids';
import {
  assertVersion,
  ctxFor,
  latestSubmittedRevision,
  loadBidRevisions,
  loadTenderAccess,
  logBidAccess,
  requireTendering,
  userNames,
  type BidRow,
  type ServiceOptions,
  type TenderAccess,
} from './shared';

/**
 * Evaluation: closed → evaluating (opening the sealed bids if nobody did
 * yet), per-evaluator criterion scores turned into weighted scores by the
 * domain, disqualification with a reason and the comparison read model.
 */

type EvaluationRow = typeof schema.bidEvaluations.$inferSelect;

function toEvaluationDto(row: EvaluationRow, evaluatorName: string | null): BidEvaluationDto {
  return {
    id: row.id,
    tenderId: row.tenderId,
    bidId: row.bidId,
    evaluatorUserId: row.evaluatorUserId,
    evaluatorName,
    scores: row.scores,
    weightedScore: row.weightedScore,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadEvaluableBid(
  tx: DbExecutor,
  identity: RequestIdentity,
  bidId: string,
): Promise<{ access: TenderAccess; bid: BidRow }> {
  const [bid] = await tx.select().from(schema.bids).where(eq(schema.bids.id, bidId));
  if (!bid) throw new ApiError('not_found', 'bid not found');
  const access = await loadTenderAccess(tx, identity, bid.tenderId, {
    staff: ['bids.evaluate'],
    customer: false,
  });
  if (access.role !== 'staff') throw new ApiError('forbidden', 'evaluation is a staff action');
  return { access, bid };
}

export async function startEvaluation(
  identity: RequestIdentity,
  tenderId: string,
  input: { reason: string; expectedVersion?: number },
  options: ServiceOptions = {},
): Promise<{ tenderId: string; status: 'evaluating'; openedBidIds: string[] }> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, {
      staff: ['bids.evaluate'],
      customer: false,
    });
    const { tender } = access;
    assertVersion(tender.version, input.expectedVersion);
    const decision = evaluateTransition(tenderMachine, {
      from: tender.status,
      to: 'evaluating',
      actor: 'staff',
    });
    if (!decision.ok)
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code },
      });
    // Opening requires bids.open_sealed (MFA) on the same actor; the domain check throws forbidden/mfa_required.
    const openedBidIds = await openBidsInTx(tx, identity, access, input.reason, options);
    const [updated] = await tx
      .update(schema.tenders)
      .set({ status: 'evaluating', version: tender.version + 1 })
      .where(and(eq(schema.tenders.id, tenderId), eq(schema.tenders.version, tender.version)))
      .returning({ id: schema.tenders.id });
    if (!updated) throw new ApiError('version_conflict', 'tender changed concurrently');
    await recordAudit(tx, identity, {
      action: 'tender.evaluation_started',
      entityType: 'tender',
      entityId: tenderId,
      organizationId: tender.organizationId,
      before: { status: tender.status },
      after: { status: 'evaluating', openedBidIds },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return { tenderId, status: 'evaluating', openedBidIds };
  });
}

/** One evaluation row per evaluator per bid (re-scoring replaces the evaluator's row). */
export async function scoreBid(
  identity: RequestIdentity,
  bidId: string,
  input: BidEvaluationInput,
  options: ServiceOptions = {},
): Promise<BidEvaluationDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access, bid } = await loadEvaluableBid(tx, identity, bidId);
    const { tender } = access;
    if (tender.status !== 'evaluating') {
      throw new ApiError(
        'invalid_transition',
        'scores are recorded while the tender is evaluating',
        { details: { status: tender.status } },
      );
    }
    if (!bid.openedAt)
      throw new ApiError('forbidden', 'the bid is sealed; open the bids first', {
        details: { code: 'bids_sealed' },
      });
    if (bid.status !== 'submitted' && bid.status !== 'evaluated') {
      throw new ApiError('invalid_transition', `a ${bid.status} bid cannot be scored`);
    }
    const result = weightedScore(tender.evaluationWeights ?? {}, input.scores);
    if (!result.ok)
      throw new ApiError('validation_failed', 'scores do not match the tender criteria', {
        details: result.violations,
      });
    const [row] = await tx
      .insert(schema.bidEvaluations)
      .values({
        tenderId: tender.id,
        bidId,
        evaluatorUserId: userId,
        scores: input.scores,
        weightedScore: result.scoreText,
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.bidEvaluations.bidId, schema.bidEvaluations.evaluatorUserId],
        set: { scores: input.scores, weightedScore: result.scoreText, notes: input.notes ?? null },
      })
      .returning();
    if (bid.status === 'submitted') {
      const transition = evaluateTransition(bidMachine, {
        from: 'submitted',
        to: 'evaluated',
        actor: 'staff',
      });
      if (!transition.ok) throw new ApiError('invalid_transition', transition.message);
      await tx
        .update(schema.bids)
        .set({ status: 'evaluated', version: bid.version + 1 })
        .where(eq(schema.bids.id, bidId));
    }
    await logBidAccess(tx, [bidId], userId, 'evaluate');
    await recordAudit(tx, identity, {
      action: 'bid.scored',
      entityType: 'bid',
      entityId: bidId,
      organizationId: tender.organizationId,
      after: { scores: input.scores, weightedScore: result.scoreText },
      correlationId: options.correlationId,
    });
    return toEvaluationDto(row!, identity.session?.user.name ?? null);
  });
}

export async function disqualifyBid(
  identity: RequestIdentity,
  bidId: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<{ bidId: string; status: 'disqualified' }> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access, bid } = await loadEvaluableBid(tx, identity, bidId);
    const decision = evaluateTransition(bidMachine, {
      from: bid.status,
      to: 'disqualified',
      actor: 'staff',
      reason: input.reason,
    });
    if (!decision.ok)
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code },
      });
    await tx
      .update(schema.bids)
      .set({ status: 'disqualified', version: bid.version + 1 })
      .where(eq(schema.bids.id, bidId));
    await recordAudit(tx, identity, {
      action: 'bid.disqualified',
      entityType: 'bid',
      entityId: bidId,
      organizationId: access.tender.organizationId,
      before: { status: bid.status },
      after: { status: 'disqualified' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return { bidId, status: 'disqualified' };
  });
}

/** Staff comparison read model: opened bids with amounts, every evaluator's scores, the mean and rank. */
export async function getTenderComparison(
  identity: RequestIdentity,
  tenderId: string,
  options: ServiceOptions = {},
): Promise<TenderComparisonDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, {
      staff: ['bids.evaluate'],
      customer: false,
    });
    const { tender } = access;
    const bids = await tx
      .select()
      .from(schema.bids)
      .where(
        and(
          eq(schema.bids.tenderId, tenderId),
          inArray(schema.bids.status, [
            'submitted',
            'evaluated',
            'disqualified',
            'awarded',
            'unsuccessful',
          ]),
        ),
      );
    if (
      !['closed', 'evaluating', 'awarded'].includes(tender.status) ||
      bids.some((b) => !b.openedAt)
    ) {
      throw new ApiError(
        'forbidden',
        'bids are sealed until opened by an authorised staff member',
        { details: { code: 'bids_sealed' } },
      );
    }
    const bidIds = bids.map((b) => b.id);
    const revisions = await loadBidRevisions(tx, bidIds);
    const evaluations = bidIds.length
      ? await tx
          .select()
          .from(schema.bidEvaluations)
          .where(inArray(schema.bidEvaluations.bidId, bidIds))
          .orderBy(asc(schema.bidEvaluations.createdAt))
      : [];
    const names = await userNames(tx, [
      ...bids.map((b) => b.partnerUserId),
      ...evaluations.map((e) => e.evaluatorUserId),
    ]);
    await logBidAccess(tx, bidIds, userId, 'read');
    const perBid = bids.map((bid) => {
      const evals = evaluations.filter((e) => e.bidId === bid.id);
      const latest = latestSubmittedRevision(revisions.get(bid.id) ?? []);
      const aggregate = aggregateWeightedScores(evals.map((e) => e.weightedScore));
      return { bid, evals, latest, aggregate };
    });
    const ranked = rankBids(
      perBid.map((p) => ({
        bidId: p.bid.id,
        averageWeightedScore: p.aggregate.mean,
        amountKobo: p.latest?.amountKobo ?? null,
        eligible:
          p.bid.status === 'evaluated' ||
          p.bid.status === 'awarded' ||
          p.bid.status === 'unsuccessful',
      })),
    );
    const rankOf = new Map(ranked.map((r) => [r.bidId, r.rank]));
    const weights = tender.evaluationWeights ?? {};
    return {
      tenderId,
      reference: tender.reference,
      status: tender.status,
      evaluationWeights: weights,
      criteria: Object.keys(weights),
      bids: perBid.map(({ bid, evals, latest, aggregate }) => ({
        bidId: bid.id,
        partnerUserId: bid.partnerUserId,
        partnerName: names.get(bid.partnerUserId) ?? null,
        status: bid.status,
        revisionVersion: latest?.version ?? null,
        amountKobo: latest ? latest.amountKobo.toString() : null,
        currency: latest?.currency ?? null,
        durationDays: latest?.durationDays ?? null,
        submittedAt: bid.submittedAt ? bid.submittedAt.toISOString() : null,
        evaluations: evals.map((e) => toEvaluationDto(e, names.get(e.evaluatorUserId) ?? null)),
        averageWeightedScore: aggregate.meanText,
        evaluatorCount: aggregate.count,
        rank: rankOf.get(bid.id) ?? null,
      })),
    };
  });
}

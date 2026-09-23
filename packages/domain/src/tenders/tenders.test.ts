import { describe, expect, it } from 'vitest';
import {
  aggregateWeightedScores,
  closeDecision,
  extensionDecision,
  questionWindowDecision,
  rankBids,
  submissionDecision,
  tenderTimelineView,
  validateEvaluationWeights,
  weightedScore,
} from './index';

const DEADLINE = '2026-09-22T16:00:00Z';

describe('validateEvaluationWeights', () => {
  it('accepts percentages summing to 100 and fractions summing to 1', () => {
    const percent = validateEvaluationWeights({ price: 60, programme: 25, quality: 15 });
    expect(percent.ok).toBe(true);
    expect(percent.scale).toBe('percent');
    expect(percent.normalized).toEqual({ price: 0.6, programme: 0.25, quality: 0.15 });

    const fraction = validateEvaluationWeights({ price: 0.6, quality: 0.4 });
    expect(fraction.ok).toBe(true);
    expect(fraction.scale).toBe('fraction');
  });

  it('rejects other sums, empty sets, zero weights and unnamed criteria', () => {
    expect(validateEvaluationWeights({ price: 50, quality: 40 }).violations[0]?.code).toBe(
      'weights_must_sum_to_100_or_1',
    );
    expect(validateEvaluationWeights({}).violations[0]?.code).toBe('no_criteria');
    expect(validateEvaluationWeights({ price: 100, quality: 0 }).violations[0]?.code).toBe(
      'invalid_weight',
    );
    expect(validateEvaluationWeights({ ' price': 100 }).violations[0]?.code).toBe(
      'invalid_criterion_name',
    );
  });
});

describe('weightedScore', () => {
  const weights = { price: 60, quality: 40 };

  it('weights each criterion score 0-100 by its share', () => {
    const result = weightedScore(weights, { price: 80, quality: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score).toBe(68);
    expect(result.scoreText).toBe('68.0000');
    expect(result.contributions).toEqual({ price: 48, quality: 20 });
  });

  it('rejects missing, out-of-range and unknown criteria', () => {
    const missing = weightedScore(weights, { price: 80 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.violations[0]).toMatchObject({ code: 'missing_score', criterion: 'quality' });

    const range = weightedScore(weights, { price: 101, quality: 50 });
    expect(range.ok).toBe(false);
    if (!range.ok) expect(range.violations[0]?.code).toBe('score_out_of_range');

    const unknown = weightedScore(weights, { price: 80, quality: 50, extra: 10 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.violations[0]).toMatchObject({ code: 'unknown_criterion', criterion: 'extra' });

    const badWeights = weightedScore({ price: 10 }, { price: 50 });
    expect(badWeights.ok).toBe(false);
  });

  it('aggregates evaluator scores and ranks bids with lower-amount tie-breaks', () => {
    const agg = aggregateWeightedScores(['68.0000', 72, null, undefined]);
    expect(agg).toMatchObject({ count: 2, mean: 70, meanText: '70.0000', min: 68, max: 72 });
    expect(aggregateWeightedScores([]).mean).toBeNull();

    const ranked = rankBids([
      { bidId: 'b', averageWeightedScore: 70, amountKobo: 900n, eligible: true },
      { bidId: 'a', averageWeightedScore: 70, amountKobo: 800n, eligible: true },
      { bidId: 'c', averageWeightedScore: 90, amountKobo: 1_000n, eligible: false },
      { bidId: 'd', averageWeightedScore: null, amountKobo: 700n, eligible: true },
      { bidId: 'e', averageWeightedScore: 80, amountKobo: null, eligible: true },
    ]);
    expect(ranked.map((r) => [r.bidId, r.rank])).toEqual([
      ['e', 1],
      ['a', 2],
      ['b', 3],
      ['c', null],
      ['d', null],
    ]);
  });
});

describe('deadline rules', () => {
  it('allows submission strictly before the effective deadline and ignores the client clock', () => {
    const before = submissionDecision({
      now: '2026-09-22T15:59:59Z',
      submissionDeadlineAt: DEADLINE,
      clientClaimedTime: '2026-09-01T00:00:00Z',
    });
    expect(before.allowed).toBe(true);
    const atDeadline = submissionDecision({
      now: DEADLINE,
      submissionDeadlineAt: DEADLINE,
      clientClaimedTime: '2026-09-01T00:00:00Z',
    });
    expect(atDeadline).toMatchObject({ allowed: false, reason: 'deadline_passed' });
    const extended = submissionDecision({
      now: '2026-09-23T10:00:00Z',
      submissionDeadlineAt: DEADLINE,
      extensions: [{ extendedTo: '2026-09-24T16:00:00Z', addendumRevision: 2 }],
    });
    expect(extended.allowed).toBe(true);
  });

  it('permits a manual close only once the deadline has passed', () => {
    expect(closeDecision({ now: '2026-09-22T15:00:00Z', submissionDeadlineAt: DEADLINE })).toMatchObject({
      canClose: false,
      reason: 'deadline_not_reached',
    });
    expect(closeDecision({ now: DEADLINE, submissionDeadlineAt: DEADLINE })).toMatchObject({
      canClose: true,
      effectiveDeadlineAt: DEADLINE,
    });
    expect(closeDecision({ now: 'not-a-time', submissionDeadlineAt: DEADLINE })).toMatchObject({
      canClose: false,
      reason: 'invalid_server_time',
    });
  });

  it('bounds the question window by the cutoff, else by the effective deadline', () => {
    expect(
      questionWindowDecision({
        now: '2026-09-11T00:00:00Z',
        questionCutoffAt: '2026-09-10T16:00:00Z',
        submissionDeadlineAt: DEADLINE,
      }),
    ).toMatchObject({ allowed: false, reason: 'question_window_closed' });
    expect(
      questionWindowDecision({
        now: '2026-09-09T00:00:00Z',
        questionCutoffAt: '2026-09-10T16:00:00Z',
        submissionDeadlineAt: DEADLINE,
      }),
    ).toMatchObject({ allowed: true, basis: 'question_cutoff' });
    expect(
      questionWindowDecision({ now: '2026-09-20T00:00:00Z', submissionDeadlineAt: DEADLINE }),
    ).toMatchObject({ allowed: true, basis: 'submission_deadline', closesAt: DEADLINE });
  });

  it('only ever extends a deadline later with an increasing addendum revision', () => {
    expect(
      extensionDecision({
        submissionDeadlineAt: DEADLINE,
        extendedTo: '2026-09-21T16:00:00Z',
        addendumRevision: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'extension_not_later' } });
    const ok = extensionDecision({
      submissionDeadlineAt: DEADLINE,
      extensions: [{ extendedTo: '2026-09-24T16:00:00Z', addendumRevision: 2 }],
      extendedTo: '2026-09-26T16:00:00Z',
      addendumRevision: 3,
    });
    expect(ok).toMatchObject({ ok: true, effectiveDeadlineAt: '2026-09-26T16:00:00Z' });
  });
});

describe('tenderTimelineView', () => {
  it('renders UTC instants and display-zone lines with the effective deadline', () => {
    const view = tenderTimelineView(
      {
        releaseAt: '2026-09-01T09:00:00Z',
        siteVisitAt: null,
        questionCutoffAt: '2026-09-10T16:00:00+01:00',
        submissionDeadlineAt: DEADLINE,
      },
      'Africa/Lagos',
      [{ extendedTo: '2026-09-24T16:00:00Z', addendumRevision: 2 }],
    );
    expect(view.utc.questionCutoffAt).toBe('2026-09-10T15:00:00Z');
    expect(view.utc.siteVisitAt).toBeNull();
    expect(view.display.timeZone).toBe('Africa/Lagos');
    expect(view.display.releaseAt).toBe('1 Sep 2026, 10:00 (Africa/Lagos)');
    expect(view.display.submissionDeadlineAt).toBe('24 Sep 2026, 17:00 (Africa/Lagos)');
    expect(view.effectiveSubmissionDeadlineAt).toBe('2026-09-24T16:00:00Z');
    expect(view.originalSubmissionDeadlineAt).toBe(DEADLINE);
    expect(view.extensionRevision).toBe(2);
    expect(view.biddingWindowDays).toBeCloseTo(23.29, 2);
  });
});

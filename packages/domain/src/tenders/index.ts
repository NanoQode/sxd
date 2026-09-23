import {
  applyDeadlineExtension,
  assertSubmissionAllowed,
  biddingWindowDays,
  effectiveDeadline,
  formatDeadlineForDisplay,
  parseInstant,
  type ApplyDeadlineExtensionResult,
  type DeadlineExtension,
  type SubmissionDecision,
  type TenderStageTimestamps,
} from '../timelines/bidding';

/**
 * Contractor tendering: weighted evaluation scoring and the deadline rules a
 * tender service needs. Every deadline decision delegates to the bidding
 * timeline engine (timelines/bidding.ts); nothing here re-implements the
 * clock or reads it. `now` is always the caller's authoritative server time.
 */

/* -------------------------------------------------------------------------- */
/* Evaluation weights                                                         */
/* -------------------------------------------------------------------------- */

export type WeightScale = 'percent' | 'fraction';

export interface WeightViolation {
  code:
    'no_criteria' | 'invalid_criterion_name' | 'invalid_weight' | 'weights_must_sum_to_100_or_1';
  criterion?: string;
  message: string;
}

export interface EvaluationWeightsValidation {
  ok: boolean;
  scale: WeightScale | null;
  criteria: string[];
  /** Weights as fractions summing to exactly 1 (within floating tolerance). */
  normalized: Record<string, number>;
  violations: WeightViolation[];
}

const PERCENT_TOLERANCE = 1e-6;
const FRACTION_TOLERANCE = 1e-9;
export const MAX_CRITERION_NAME_LENGTH = 64;

/**
 * Weights must use named criteria and sum to 100 (percentages) or 1.0
 * (fractions). Zero and negative weights are rejected: a criterion that
 * cannot influence the result should not be listed.
 */
export function validateEvaluationWeights(
  weights: Record<string, number> | null | undefined,
): EvaluationWeightsValidation {
  const violations: WeightViolation[] = [];
  const entries = Object.entries(weights ?? {});
  if (entries.length === 0) {
    violations.push({ code: 'no_criteria', message: 'at least one named criterion is required' });
    return { ok: false, scale: null, criteria: [], normalized: {}, violations };
  }
  let sum = 0;
  for (const [criterion, weight] of entries) {
    const name = criterion.trim();
    if (name.length === 0 || name.length > MAX_CRITERION_NAME_LENGTH || name !== criterion) {
      violations.push({
        code: 'invalid_criterion_name',
        criterion,
        message: `criterion names must be 1-${MAX_CRITERION_NAME_LENGTH} characters without surrounding whitespace`,
      });
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      violations.push({
        code: 'invalid_weight',
        criterion,
        message: `weight for ${criterion} must be a positive finite number`,
      });
      continue;
    }
    sum += weight;
  }
  let scale: WeightScale | null = null;
  if (Math.abs(sum - 100) <= PERCENT_TOLERANCE) scale = 'percent';
  else if (Math.abs(sum - 1) <= FRACTION_TOLERANCE) scale = 'fraction';
  if (violations.length === 0 && scale === null) {
    violations.push({
      code: 'weights_must_sum_to_100_or_1',
      message: `weights sum to ${sum}; they must sum to 100 (percent) or 1.0 (fractions)`,
    });
  }
  const normalized: Record<string, number> = {};
  if (violations.length === 0 && scale) {
    const divisor = scale === 'percent' ? 100 : 1;
    for (const [criterion, weight] of entries) normalized[criterion] = weight / divisor;
  }
  return {
    ok: violations.length === 0,
    scale,
    criteria: entries.map(([c]) => c),
    normalized,
    violations,
  };
}

/* -------------------------------------------------------------------------- */
/* Weighted scoring                                                           */
/* -------------------------------------------------------------------------- */

export interface ScoreViolation {
  code: 'invalid_weights' | 'missing_score' | 'score_out_of_range' | 'unknown_criterion';
  criterion?: string;
  message: string;
}

export type WeightedScoreResult =
  | {
      ok: true;
      /** 0-100, rounded to four decimals. */
      score: number;
      /** Same value as a decimal string with four decimals (numeric(8,4) storage). */
      scoreText: string;
      contributions: Record<string, number>;
    }
  | { ok: false; violations: ScoreViolation[] };

export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/**
 * Weighted score for one evaluator's marks: every criterion of the tender's
 * weights must be scored 0-100; scores for criteria the tender does not
 * define are rejected so a typo cannot silently drop a mark.
 */
export function weightedScore(
  weights: Record<string, number>,
  scores: Record<string, number>,
): WeightedScoreResult {
  const validation = validateEvaluationWeights(weights);
  if (!validation.ok) {
    return {
      ok: false,
      violations: [{ code: 'invalid_weights', message: validation.violations[0]!.message }],
    };
  }
  const violations: ScoreViolation[] = [];
  const contributions: Record<string, number> = {};
  let total = 0;
  for (const criterion of validation.criteria) {
    const value = scores[criterion];
    if (value === undefined || value === null) {
      violations.push({
        code: 'missing_score',
        criterion,
        message: `a score for ${criterion} is required`,
      });
      continue;
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < SCORE_MIN ||
      value > SCORE_MAX
    ) {
      violations.push({
        code: 'score_out_of_range',
        criterion,
        message: `score for ${criterion} must be between ${SCORE_MIN} and ${SCORE_MAX}`,
      });
      continue;
    }
    const contribution = validation.normalized[criterion]! * value;
    contributions[criterion] = contribution;
    total += contribution;
  }
  for (const key of Object.keys(scores)) {
    if (!(key in validation.normalized)) {
      violations.push({
        code: 'unknown_criterion',
        criterion: key,
        message: `${key} is not an evaluation criterion of this tender`,
      });
    }
  }
  if (violations.length > 0) return { ok: false, violations };
  const score = Math.round(total * 10_000) / 10_000;
  return { ok: true, score, scoreText: score.toFixed(4), contributions };
}

export interface ScoreAggregate {
  count: number;
  mean: number | null;
  meanText: string | null;
  min: number | null;
  max: number | null;
}

/** Mean of the evaluators' weighted scores (null values are ignored). */
export function aggregateWeightedScores(
  values: ReadonlyArray<number | string | null | undefined>,
): ScoreAggregate {
  const numbers: number[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = typeof v === 'string' ? Number(v) : v;
    if (Number.isFinite(n)) numbers.push(n);
  }
  if (numbers.length === 0) return { count: 0, mean: null, meanText: null, min: null, max: null };
  const sum = numbers.reduce((a, b) => a + b, 0);
  const mean = Math.round((sum / numbers.length) * 10_000) / 10_000;
  return {
    count: numbers.length,
    mean,
    meanText: mean.toFixed(4),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  };
}

export interface RankableBid {
  bidId: string;
  /** Mean weighted score, or null when nobody has scored the bid yet. */
  averageWeightedScore: number | null;
  /** Latest submitted amount, used to break score ties (lower wins). */
  amountKobo: bigint | null;
  /** Withdrawn and disqualified bids are listed but never ranked. */
  eligible: boolean;
}

export interface RankedBid extends RankableBid {
  rank: number | null;
}

/**
 * Orders bids by mean weighted score (highest first); ties go to the lower
 * amount, then to the bid id for a stable order. Unscored or ineligible bids
 * keep `rank: null` and trail the ranked ones.
 */
export function rankBids(bids: ReadonlyArray<RankableBid>): RankedBid[] {
  const ranked = bids
    .filter((b) => b.eligible && b.averageWeightedScore !== null)
    .sort((a, b) => {
      const diff = (b.averageWeightedScore ?? 0) - (a.averageWeightedScore ?? 0);
      if (diff !== 0) return diff;
      if (a.amountKobo !== null && b.amountKobo !== null && a.amountKobo !== b.amountKobo) {
        return a.amountKobo < b.amountKobo ? -1 : 1;
      }
      return a.bidId < b.bidId ? -1 : a.bidId > b.bidId ? 1 : 0;
    })
    .map((b, i) => ({ ...b, rank: i + 1 }));
  const rest = bids
    .filter((b) => !(b.eligible && b.averageWeightedScore !== null))
    .map((b) => ({ ...b, rank: null }));
  return [...ranked, ...rest];
}

/* -------------------------------------------------------------------------- */
/* Deadline rules (delegating to the bidding timeline engine)                 */
/* -------------------------------------------------------------------------- */

export interface DeadlineContext {
  /** Authoritative server time (ISO 8601 with offset). Never a client value. */
  now: string;
  submissionDeadlineAt: string;
  extensions?: DeadlineExtension[];
}

/** Whether a bid may be submitted, revised or withdrawn right now. */
export function submissionDecision(
  input: DeadlineContext & { clientClaimedTime?: string | null },
): SubmissionDecision {
  return assertSubmissionAllowed(input);
}

export type CloseDecision =
  | { canClose: true; effectiveDeadlineAt: string }
  | {
      canClose: false;
      reason: 'deadline_not_reached' | 'invalid_deadline' | 'invalid_server_time';
      effectiveDeadlineAt: string | null;
    };

/** A tender may be closed manually only once the effective deadline has passed. */
export function closeDecision(input: DeadlineContext): CloseDecision {
  const decision = assertSubmissionAllowed(input);
  if (decision.allowed) {
    return {
      canClose: false,
      reason: 'deadline_not_reached',
      effectiveDeadlineAt: decision.effectiveDeadlineAt,
    };
  }
  if (decision.reason === 'deadline_passed') {
    return { canClose: true, effectiveDeadlineAt: decision.effectiveDeadlineAt as string };
  }
  return {
    canClose: false,
    reason: decision.reason,
    effectiveDeadlineAt: decision.effectiveDeadlineAt,
  };
}

export type QuestionWindowDecision =
  | { allowed: true; closesAt: string; basis: 'question_cutoff' | 'submission_deadline' }
  | {
      allowed: false;
      reason: 'question_window_closed' | 'invalid_timestamp';
      closesAt: string | null;
    };

/**
 * Questions may be asked until the question cutoff; when a tender has no
 * cutoff the effective submission deadline bounds the window instead.
 */
export function questionWindowDecision(
  input: DeadlineContext & { questionCutoffAt?: string | null },
): QuestionWindowDecision {
  const now = parseInstant(input.now);
  if (!now) return { allowed: false, reason: 'invalid_timestamp', closesAt: null };
  if (input.questionCutoffAt) {
    const cutoff = parseInstant(input.questionCutoffAt);
    if (!cutoff) return { allowed: false, reason: 'invalid_timestamp', closesAt: null };
    const closesAt = cutoff.toISO({ suppressMilliseconds: true }) as string;
    return now < cutoff
      ? { allowed: true, closesAt, basis: 'question_cutoff' }
      : { allowed: false, reason: 'question_window_closed', closesAt };
  }
  const deadline = effectiveDeadline(input);
  if (!deadline.ok) return { allowed: false, reason: 'invalid_timestamp', closesAt: null };
  const closesAt = deadline.effectiveDeadlineAt;
  return now < (parseInstant(closesAt) as NonNullable<ReturnType<typeof parseInstant>>)
    ? { allowed: true, closesAt, basis: 'submission_deadline' }
    : { allowed: false, reason: 'question_window_closed', closesAt };
}

/** Deadline extension for an addendum: later than the deadline in force, increasing revision. */
export function extensionDecision(input: {
  submissionDeadlineAt: string;
  extensions?: DeadlineExtension[];
  extendedTo: string;
  addendumRevision: number;
}): ApplyDeadlineExtensionResult {
  return applyDeadlineExtension({
    submissionDeadlineAt: input.submissionDeadlineAt,
    extensions: input.extensions,
    extension: { extendedTo: input.extendedTo, addendumRevision: input.addendumRevision },
  });
}

/* -------------------------------------------------------------------------- */
/* Timeline view                                                              */
/* -------------------------------------------------------------------------- */

export const TENDER_TIMELINE_FIELDS = [
  'releaseAt',
  'siteVisitAt',
  'questionCutoffAt',
  'answersPublishedAt',
  'submissionDeadlineAt',
  'evaluationCompleteAt',
  'awardTargetAt',
] as const;
export type TenderTimelineField = (typeof TENDER_TIMELINE_FIELDS)[number];

export type TimelineValues = Record<TenderTimelineField, string | null>;

export interface TenderTimelineView {
  /** Every stage as a UTC instant (null when not set). */
  utc: TimelineValues;
  /** The same instants rendered in the tender's display time zone. */
  display: TimelineValues & { timeZone: string };
  /** Deadline in force after extensions (UTC). */
  effectiveSubmissionDeadlineAt: string | null;
  originalSubmissionDeadlineAt: string | null;
  /** Revision of the addendum whose extension is in force, or null. */
  extensionRevision: number | null;
  biddingWindowDays: number | null;
}

/**
 * Renders a stored timeline for display: UTC instants plus one line per
 * stage in the display zone (`22 Sep 2026, 17:00 (Africa/Lagos)`).
 */
export function tenderTimelineView(
  timeline: Partial<TenderStageTimestamps>,
  displayTimeZone: string,
  extensions: DeadlineExtension[] = [],
): TenderTimelineView {
  const utc = {} as TimelineValues;
  const display = { timeZone: displayTimeZone } as TimelineValues & { timeZone: string };
  for (const field of TENDER_TIMELINE_FIELDS) {
    const raw = timeline[field] ?? null;
    const instant = raw ? parseInstant(raw) : null;
    utc[field] = instant ? (instant.toISO({ suppressMilliseconds: true }) as string) : null;
    display[field] = utc[field]
      ? (formatDeadlineForDisplay(utc[field], [displayTimeZone])[0] ?? null)
      : null;
  }
  let effectiveSubmissionDeadlineAt: string | null = null;
  let originalSubmissionDeadlineAt: string | null = null;
  let extensionRevision: number | null = null;
  let windowDays: number | null = null;
  if (utc.submissionDeadlineAt) {
    const deadline = effectiveDeadline({
      submissionDeadlineAt: utc.submissionDeadlineAt,
      extensions,
    });
    if (deadline.ok) {
      effectiveSubmissionDeadlineAt = deadline.effectiveDeadlineAt;
      originalSubmissionDeadlineAt = deadline.originalDeadlineAt;
      extensionRevision = deadline.addendumRevision;
      display.submissionDeadlineAt =
        formatDeadlineForDisplay(deadline.effectiveDeadlineAt, [displayTimeZone])[0] ?? null;
    }
    if (utc.releaseAt) {
      windowDays = biddingWindowDays({
        releaseAt: utc.releaseAt,
        submissionDeadlineAt: utc.submissionDeadlineAt,
        extensions,
      });
    }
  }
  return {
    utc,
    display,
    effectiveSubmissionDeadlineAt,
    originalSubmissionDeadlineAt,
    extensionRevision,
    biddingWindowDays: windowDays,
  };
}

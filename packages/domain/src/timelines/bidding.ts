import { DateTime } from 'luxon';

/**
 * Bidding (tender) timeline (system B of the timelines specification).
 *
 * Specification, quoted:
 *
 * > Stages: tender release, site visit, question cutoff, answer publication,
 * > submission deadline, evaluation, award. `validateTenderTimeline(stages)`
 * > enforcing chronological order (each present stage after the previous
 * > present one; site visit optional; question cutoff before answers before
 * > deadline) with a list of violations.
 * >
 * > Deadlines use authoritative server timestamps: `isSubmissionOpen({ now,
 * > submissionDeadlineAt, extensions })` – the effective deadline is the
 * > latest extension (extensions can only move later; reject an "extension"
 * > earlier than the current deadline via `applyDeadlineExtension`).
 * > Time-zone display helper `formatDeadlineForDisplay(iso, timeZones)`
 * > returning one line per zone (`22 Sep 2026, 17:00 (Africa/Lagos)` style).
 * > Bidding window days = (effective deadline − release) in days.
 * >
 * > Addenda versioning: `nextAddendumRevision(currentRevision)` and a
 * > `TenderRevisionRecord` type.
 * >
 * > Late acceptance must be impossible via stale clients:
 * > `assertSubmissionAllowed({ now, deadline..., clientClaimedTime })` ignores
 * > clientClaimedTime and returns `{ allowed: false, reason: 'deadline_passed' }`
 * > when now >= effective deadline (inclusive: at the deadline instant, closed).
 *
 * Every timestamp is an ISO 8601 date-time with an explicit UTC offset
 * (`2026-09-22T16:00:00Z`, `2026-09-22T17:00:00+01:00`). Date-only strings
 * and offset-less date-times are rejected as invalid because a deadline
 * without an offset is ambiguous. `now` must be the server's clock; nothing
 * here reads the wall clock.
 */

export const TENDER_STAGES = [
  'tender_release',
  'site_visit',
  'question_cutoff',
  'answer_publication',
  'submission_deadline',
  'evaluation',
  'award',
] as const;
export type TenderStage = (typeof TENDER_STAGES)[number];

export interface TenderStageTimestamps {
  releaseAt: string;
  siteVisitAt?: string | null;
  questionCutoffAt?: string | null;
  answersPublishedAt?: string | null;
  submissionDeadlineAt: string;
  evaluationCompleteAt?: string | null;
  awardTargetAt?: string | null;
}

const STAGE_FIELDS: ReadonlyArray<{
  stage: TenderStage;
  field: keyof TenderStageTimestamps;
  required: boolean;
}> = [
  { stage: 'tender_release', field: 'releaseAt', required: true },
  { stage: 'site_visit', field: 'siteVisitAt', required: false },
  { stage: 'question_cutoff', field: 'questionCutoffAt', required: false },
  { stage: 'answer_publication', field: 'answersPublishedAt', required: false },
  { stage: 'submission_deadline', field: 'submissionDeadlineAt', required: true },
  { stage: 'evaluation', field: 'evaluationCompleteAt', required: false },
  { stage: 'award', field: 'awardTargetAt', required: false },
];

export interface TenderTimelineViolation {
  code: 'missing_required' | 'invalid_timestamp' | 'out_of_order';
  stage: TenderStage;
  field: keyof TenderStageTimestamps;
  /** For `out_of_order`: the present stage this one must come after. */
  previousStage?: TenderStage;
  message: string;
}

export interface TenderTimelineValidation {
  ok: boolean;
  violations: TenderTimelineViolation[];
  /** Present, valid stages in canonical order with their instants normalised to UTC. */
  stages: Array<{ stage: TenderStage; at: string }>;
}

/**
 * Parses an ISO 8601 date-time that carries an explicit offset (`Z` or
 * `±hh:mm`) and returns it in UTC, or null when the value is not such a
 * timestamp.
 */
export function parseInstant(value: unknown): DateTime | null {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return null;
  const dt = DateTime.fromISO(value, { setZone: true });
  return dt.isValid ? dt.toUTC() : null;
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;

function toIso(dt: DateTime): string {
  const iso = dt.toUTC().toISO({ suppressMilliseconds: true });
  if (iso === null) throw new RangeError('Invalid DateTime');
  return iso;
}

/**
 * Checks that every present stage comes strictly after the previous present
 * stage in the canonical order. Site visit, question cutoff, answer
 * publication, evaluation and award are optional; release and deadline are
 * required.
 */
export function validateTenderTimeline(stages: TenderStageTimestamps): TenderTimelineValidation {
  const violations: TenderTimelineViolation[] = [];
  const present: Array<{ stage: TenderStage; at: string }> = [];
  let previous: { stage: TenderStage; instant: DateTime } | null = null;

  for (const { stage, field, required } of STAGE_FIELDS) {
    const value = stages[field];
    if (value === undefined || value === null) {
      if (required) {
        violations.push({
          code: 'missing_required',
          stage,
          field,
          message: `${field} is required`,
        });
      }
      continue;
    }
    const instant = parseInstant(value);
    if (!instant) {
      violations.push({
        code: 'invalid_timestamp',
        stage,
        field,
        message: `${field} must be an ISO 8601 date-time with an explicit UTC offset`,
      });
      continue;
    }
    if (previous && instant <= previous.instant) {
      violations.push({
        code: 'out_of_order',
        stage,
        field,
        previousStage: previous.stage,
        message: `${stage} (${toIso(instant)}) must be after ${previous.stage} (${toIso(previous.instant)})`,
      });
    }
    present.push({ stage, at: toIso(instant) });
    previous = { stage, instant };
  }

  return { ok: violations.length === 0, violations, stages: present };
}

/* -------------------------------------------------------------------------- */
/* Deadlines and extensions                                                   */
/* -------------------------------------------------------------------------- */

export interface DeadlineExtension {
  /** New deadline instant; must be later than the deadline in force when it was issued. */
  extendedTo: string;
  /** The addendum revision that announced the extension. */
  addendumRevision: number;
}

export interface DeadlineInput {
  /** The original, server-recorded submission deadline. */
  submissionDeadlineAt: string;
  extensions?: DeadlineExtension[];
}

export type EffectiveDeadline =
  | {
      ok: true;
      effectiveDeadlineAt: string;
      originalDeadlineAt: string;
      source: 'original' | 'extension';
      /** Revision of the extension in force, or null when the original deadline stands. */
      addendumRevision: number | null;
      ignoredExtensions: Array<{
        extension: DeadlineExtension;
        reason: 'invalid_timestamp' | 'not_later';
      }>;
    }
  | { ok: false; error: { code: 'invalid_timestamp'; field: 'submissionDeadlineAt' } };

/**
 * The deadline in force: the latest valid extension, or the original deadline
 * when no extension moves it later. An "extension" that does not move the
 * deadline later has no effect and is listed under `ignoredExtensions`.
 */
export function effectiveDeadline(input: DeadlineInput): EffectiveDeadline {
  const original = parseInstant(input.submissionDeadlineAt);
  if (!original) {
    return { ok: false, error: { code: 'invalid_timestamp', field: 'submissionDeadlineAt' } };
  }
  let effective = original;
  let source: 'original' | 'extension' = 'original';
  let addendumRevision: number | null = null;
  const ignoredExtensions: Array<{
    extension: DeadlineExtension;
    reason: 'invalid_timestamp' | 'not_later';
  }> = [];
  for (const extension of input.extensions ?? []) {
    const instant = parseInstant(extension.extendedTo);
    if (!instant) {
      ignoredExtensions.push({ extension, reason: 'invalid_timestamp' });
      continue;
    }
    if (instant <= effective) {
      ignoredExtensions.push({ extension, reason: 'not_later' });
      continue;
    }
    effective = instant;
    source = 'extension';
    addendumRevision = extension.addendumRevision;
  }
  return {
    ok: true,
    effectiveDeadlineAt: toIso(effective),
    originalDeadlineAt: toIso(original),
    source,
    addendumRevision,
    ignoredExtensions,
  };
}

export type ApplyDeadlineExtensionResult =
  | { ok: true; extensions: DeadlineExtension[]; effectiveDeadlineAt: string }
  | {
      ok: false;
      error:
        | { code: 'invalid_timestamp'; field: 'submissionDeadlineAt' | 'extendedTo' }
        | { code: 'extension_not_later'; currentDeadlineAt: string; requestedAt: string }
        | { code: 'revision_not_increasing'; currentRevision: number; requestedRevision: number };
    };

/**
 * Appends an extension. Extensions can only move the deadline later: a
 * request at or before the deadline currently in force is rejected with
 * `extension_not_later`, and its addendum revision must exceed the revision
 * of every extension already recorded.
 */
export function applyDeadlineExtension(
  input: DeadlineInput & { extension: DeadlineExtension },
): ApplyDeadlineExtensionResult {
  const current = effectiveDeadline(input);
  if (!current.ok) return current;
  const requested = parseInstant(input.extension.extendedTo);
  if (!requested) return { ok: false, error: { code: 'invalid_timestamp', field: 'extendedTo' } };
  const currentInstant = parseInstant(current.effectiveDeadlineAt) as DateTime;
  if (requested <= currentInstant) {
    return {
      ok: false,
      error: {
        code: 'extension_not_later',
        currentDeadlineAt: current.effectiveDeadlineAt,
        requestedAt: toIso(requested),
      },
    };
  }
  const highestRevision = Math.max(0, ...(input.extensions ?? []).map((e) => e.addendumRevision));
  const requestedRevision = input.extension.addendumRevision;
  if (!Number.isInteger(requestedRevision) || requestedRevision <= highestRevision) {
    return {
      ok: false,
      error: {
        code: 'revision_not_increasing',
        currentRevision: highestRevision,
        requestedRevision,
      },
    };
  }
  return {
    ok: true,
    extensions: [...(input.extensions ?? []), input.extension],
    effectiveDeadlineAt: toIso(requested),
  };
}

export interface SubmissionWindowInput extends DeadlineInput {
  /** Authoritative server time. Never a client-supplied value. */
  now: string;
}

/**
 * True while `now` is strictly before the effective deadline. Closed at the
 * deadline instant itself, and closed (fail-safe) when any timestamp is
 * invalid.
 */
export function isSubmissionOpen(input: SubmissionWindowInput): boolean {
  const now = parseInstant(input.now);
  const deadline = effectiveDeadline(input);
  if (!now || !deadline.ok) return false;
  return now < (parseInstant(deadline.effectiveDeadlineAt) as DateTime);
}

export type SubmissionDecision =
  | {
      allowed: true;
      effectiveDeadlineAt: string;
      evaluatedAt: string;
      remainingSeconds: number;
    }
  | {
      allowed: false;
      reason: 'deadline_passed' | 'invalid_deadline' | 'invalid_server_time';
      effectiveDeadlineAt: string | null;
      evaluatedAt: string | null;
    };

/**
 * Decides whether a submission may be accepted. Only the server's `now` is
 * consulted: `clientClaimedTime` is accepted so that callers can log what a
 * (possibly stale) client believed, but it never influences the decision.
 * At the deadline instant (`now >= deadline`) the answer is `deadline_passed`.
 */
export function assertSubmissionAllowed(
  input: SubmissionWindowInput & { clientClaimedTime?: string | null },
): SubmissionDecision {
  const deadline = effectiveDeadline(input);
  if (!deadline.ok) {
    return {
      allowed: false,
      reason: 'invalid_deadline',
      effectiveDeadlineAt: null,
      evaluatedAt: null,
    };
  }
  const now = parseInstant(input.now);
  if (!now) {
    return {
      allowed: false,
      reason: 'invalid_server_time',
      effectiveDeadlineAt: deadline.effectiveDeadlineAt,
      evaluatedAt: null,
    };
  }
  const deadlineInstant = parseInstant(deadline.effectiveDeadlineAt) as DateTime;
  if (now >= deadlineInstant) {
    return {
      allowed: false,
      reason: 'deadline_passed',
      effectiveDeadlineAt: deadline.effectiveDeadlineAt,
      evaluatedAt: toIso(now),
    };
  }
  return {
    allowed: true,
    effectiveDeadlineAt: deadline.effectiveDeadlineAt,
    evaluatedAt: toIso(now),
    remainingSeconds: Math.floor((deadlineInstant.toMillis() - now.toMillis()) / 1000),
  };
}

/* -------------------------------------------------------------------------- */
/* Display and window length                                                  */
/* -------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One display line per IANA time zone, e.g. `22 Sep 2026, 17:00 (Africa/Lagos)`.
 * The date is written out in full (day, abbreviated month, four-digit year)
 * so that no reader has to guess a day/month order. Month names are fixed
 * English abbreviations rather than locale data, so the output does not
 * depend on the host's ICU build.
 */
export function formatDeadlineForDisplay(iso: string, timeZones: string[]): string[] {
  const instant = parseInstant(iso);
  return timeZones.map((zone) => {
    if (!instant) return `Invalid deadline (${zone})`;
    const local = instant.setZone(zone);
    if (!local.isValid) return `${formatParts(instant)} UTC (unknown time zone: ${zone})`;
    return `${formatParts(local)} (${zone})`;
  });
}

function formatParts(dt: DateTime): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.day} ${MONTHS[dt.month - 1]} ${dt.year}, ${pad(dt.hour)}:${pad(dt.minute)}`;
}

export interface BiddingWindowInput extends DeadlineInput {
  releaseAt: string;
}

/**
 * Length of the bidding window in days: (effective deadline − release),
 * fractional. Returns null when a timestamp is invalid.
 *
 * A short window is not automatically desirable: bidders need time to visit
 * the site, ask questions, price the work and obtain approvals, and a window
 * that is too short reduces competition and bid quality. Present the number;
 * do not rank tenders by it.
 */
export function biddingWindowDays(input: BiddingWindowInput): number | null {
  const release = parseInstant(input.releaseAt);
  const deadline = effectiveDeadline(input);
  if (!release || !deadline.ok) return null;
  const end = parseInstant(deadline.effectiveDeadlineAt) as DateTime;
  return (end.toMillis() - release.toMillis()) / 86_400_000;
}

/* -------------------------------------------------------------------------- */
/* Addenda versioning                                                         */
/* -------------------------------------------------------------------------- */

/** A versioned change to a published tender (an addendum). Revision 1 is the original issue. */
export interface TenderRevisionRecord {
  revision: number;
  issuedAt: string;
  changes: Record<string, unknown>;
  addendumMarkdown?: string | null;
  /** Present when this addendum extended the submission deadline. */
  deadlineExtendedTo?: string | null;
  reason?: string | null;
  issuedBy?: string | null;
}

/** The revision number the next addendum will carry. */
export function nextAddendumRevision(currentRevision: number): number {
  if (!Number.isInteger(currentRevision) || currentRevision < 0) {
    throw new RangeError(
      `currentRevision must be a non-negative integer, got ${String(currentRevision)}`,
    );
  }
  return currentRevision + 1;
}

/** Extracts the deadline extensions from a tender's revision history. */
export function extensionsFromRevisions(revisions: TenderRevisionRecord[]): DeadlineExtension[] {
  return revisions
    .filter(
      (r): r is TenderRevisionRecord & { deadlineExtendedTo: string } =>
        typeof r.deadlineExtendedTo === 'string',
    )
    .map((r) => ({ extendedTo: r.deadlineExtendedTo, addendumRevision: r.revision }));
}

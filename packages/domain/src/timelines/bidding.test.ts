import { describe, expect, it } from 'vitest';
import {
  applyDeadlineExtension,
  assertSubmissionAllowed,
  biddingWindowDays,
  effectiveDeadline,
  extensionsFromRevisions,
  formatDeadlineForDisplay,
  isSubmissionOpen,
  nextAddendumRevision,
  validateTenderTimeline,
} from './bidding';

const RELEASE = '2026-09-01T09:00:00Z';
const DEADLINE = '2026-09-22T16:00:00Z';

describe('validateTenderTimeline', () => {
  it('accepts a chronological timeline with the optional site visit omitted', () => {
    const result = validateTenderTimeline({
      releaseAt: RELEASE,
      questionCutoffAt: '2026-09-10T16:00:00Z',
      answersPublishedAt: '2026-09-14T16:00:00Z',
      submissionDeadlineAt: DEADLINE,
      evaluationCompleteAt: '2026-10-06T16:00:00Z',
      awardTargetAt: '2026-10-13T16:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.stages.map((s) => s.stage)).toEqual([
      'tender_release',
      'question_cutoff',
      'answer_publication',
      'submission_deadline',
      'evaluation',
      'award',
    ]);
  });

  it('reports answers published before the question cutoff and a deadline before release', () => {
    const result = validateTenderTimeline({
      releaseAt: RELEASE,
      siteVisitAt: '2026-09-05T10:00:00+01:00',
      questionCutoffAt: '2026-09-14T16:00:00Z',
      answersPublishedAt: '2026-09-10T16:00:00Z',
      submissionDeadlineAt: '2026-08-30T16:00:00Z',
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toMatchObject({
      code: 'out_of_order',
      stage: 'answer_publication',
      previousStage: 'question_cutoff',
    });
    expect(result.violations[1]).toMatchObject({
      code: 'out_of_order',
      stage: 'submission_deadline',
      previousStage: 'answer_publication',
    });
  });

  it('rejects timestamps without an explicit offset and missing required stages', () => {
    const result = validateTenderTimeline({
      releaseAt: '2026-09-01T09:00:00',
      submissionDeadlineAt: null as unknown as string,
    });
    expect(result.violations.map((v) => v.code)).toEqual(['invalid_timestamp', 'missing_required']);
  });
});

describe('deadline extensions', () => {
  it('takes the latest extension as the effective deadline', () => {
    const result = effectiveDeadline({
      submissionDeadlineAt: DEADLINE,
      extensions: [
        { extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 },
        { extendedTo: '2026-10-06T16:00:00Z', addendumRevision: 3 },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      effectiveDeadlineAt: '2026-10-06T16:00:00Z',
      source: 'extension',
      addendumRevision: 3,
    });
  });

  it('only lets an extension move the deadline later', () => {
    const rejected = applyDeadlineExtension({
      submissionDeadlineAt: DEADLINE,
      extensions: [],
      extension: { extendedTo: '2026-09-20T16:00:00Z', addendumRevision: 2 },
    });
    expect(rejected).toEqual({
      ok: false,
      error: {
        code: 'extension_not_later',
        currentDeadlineAt: DEADLINE,
        requestedAt: '2026-09-20T16:00:00Z',
      },
    });

    const sameInstant = applyDeadlineExtension({
      submissionDeadlineAt: DEADLINE,
      extensions: [],
      extension: { extendedTo: '2026-09-22T17:00:00+01:00', addendumRevision: 2 },
    });
    expect(sameInstant.ok).toBe(false);

    const accepted = applyDeadlineExtension({
      submissionDeadlineAt: DEADLINE,
      extensions: [],
      extension: { extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 },
    });
    expect(accepted).toEqual({
      ok: true,
      extensions: [{ extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 }],
      effectiveDeadlineAt: '2026-09-29T16:00:00Z',
    });
  });

  it('requires addendum revisions to increase', () => {
    const result = applyDeadlineExtension({
      submissionDeadlineAt: DEADLINE,
      extensions: [{ extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 }],
      extension: { extendedTo: '2026-10-06T16:00:00Z', addendumRevision: 2 },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'revision_not_increasing' } });
  });

  it('derives extensions from the revision history', () => {
    expect(
      extensionsFromRevisions([
        { revision: 1, issuedAt: RELEASE, changes: {} },
        {
          revision: 2,
          issuedAt: '2026-09-15T10:00:00Z',
          changes: {},
          deadlineExtendedTo: '2026-09-29T16:00:00Z',
        },
      ]),
    ).toEqual([{ extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 }]);
  });
});

describe('submission window', () => {
  it('is open before the deadline and closed from the deadline instant onwards', () => {
    expect(isSubmissionOpen({ now: '2026-09-22T15:59:59Z', submissionDeadlineAt: DEADLINE })).toBe(
      true,
    );
    expect(isSubmissionOpen({ now: DEADLINE, submissionDeadlineAt: DEADLINE })).toBe(false);
    expect(isSubmissionOpen({ now: '2026-09-22T16:00:01Z', submissionDeadlineAt: DEADLINE })).toBe(
      false,
    );
  });

  it('stays open until an extended deadline', () => {
    expect(
      isSubmissionOpen({
        now: '2026-09-25T12:00:00Z',
        submissionDeadlineAt: DEADLINE,
        extensions: [{ extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 }],
      }),
    ).toBe(true);
  });

  it('closes at the deadline instant regardless of what a stale client claims', () => {
    const decision = assertSubmissionAllowed({
      now: DEADLINE,
      submissionDeadlineAt: DEADLINE,
      clientClaimedTime: '2026-09-22T15:00:00Z',
    });
    expect(decision).toEqual({
      allowed: false,
      reason: 'deadline_passed',
      effectiveDeadlineAt: DEADLINE,
      evaluatedAt: DEADLINE,
    });
  });

  it('allows a submission before the deadline and reports the remaining time', () => {
    const decision = assertSubmissionAllowed({
      now: '2026-09-22T15:00:00Z',
      submissionDeadlineAt: DEADLINE,
      clientClaimedTime: '2026-09-23T15:00:00Z',
    });
    expect(decision).toEqual({
      allowed: true,
      effectiveDeadlineAt: DEADLINE,
      evaluatedAt: '2026-09-22T15:00:00Z',
      remainingSeconds: 3600,
    });
  });

  it('fails closed when the deadline or server time is unusable', () => {
    expect(isSubmissionOpen({ now: '2026-09-01T00:00:00Z', submissionDeadlineAt: 'soon' })).toBe(
      false,
    );
    expect(assertSubmissionAllowed({ now: 'now', submissionDeadlineAt: DEADLINE })).toMatchObject({
      allowed: false,
      reason: 'invalid_server_time',
    });
  });
});

describe('display and window length', () => {
  it('formats the deadline once per time zone with an explicit date', () => {
    expect(formatDeadlineForDisplay(DEADLINE, ['Africa/Lagos', 'America/Toronto', 'UTC'])).toEqual([
      '22 Sep 2026, 17:00 (Africa/Lagos)',
      '22 Sep 2026, 12:00 (America/Toronto)',
      '22 Sep 2026, 16:00 (UTC)',
    ]);
  });

  it('marks unknown zones instead of guessing', () => {
    expect(formatDeadlineForDisplay(DEADLINE, ['Mars/Olympus'])).toEqual([
      '22 Sep 2026, 16:00 UTC (unknown time zone: Mars/Olympus)',
    ]);
  });

  it('measures the bidding window from release to the effective deadline', () => {
    expect(biddingWindowDays({ releaseAt: RELEASE, submissionDeadlineAt: DEADLINE })).toBeCloseTo(
      21 + 7 / 24,
      6,
    );
    expect(
      biddingWindowDays({
        releaseAt: RELEASE,
        submissionDeadlineAt: DEADLINE,
        extensions: [{ extendedTo: '2026-09-29T16:00:00Z', addendumRevision: 2 }],
      }),
    ).toBeCloseTo(28 + 7 / 24, 6);
    expect(
      biddingWindowDays({ releaseAt: '2026-09-01', submissionDeadlineAt: DEADLINE }),
    ).toBeNull();
  });
});

describe('addenda versioning', () => {
  it('increments the revision and rejects nonsense', () => {
    expect(nextAddendumRevision(1)).toBe(2);
    expect(nextAddendumRevision(7)).toBe(8);
    expect(() => nextAddendumRevision(-1)).toThrow(RangeError);
    expect(() => nextAddendumRevision(1.5)).toThrow(RangeError);
  });
});

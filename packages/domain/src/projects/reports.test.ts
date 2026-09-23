import { describe, expect, it } from 'vitest';
import {
  assertNotAuthor,
  canAddRevision,
  reportTransition,
  revisionState,
  validateNamedReviewer,
} from './reports';

describe('report review rules', () => {
  it('requires a named reviewer who is not the author', () => {
    expect(validateNamedReviewer({ authorUserId: 'a', reviewerUserId: undefined }).ok).toBe(false);
    expect(validateNamedReviewer({ authorUserId: 'a', reviewerUserId: 'a' })).toEqual({
      ok: false,
      reason: 'the named reviewer must not be the author of the report',
    });
    expect(validateNamedReviewer({ authorUserId: 'a', reviewerUserId: 'b' })).toEqual({ ok: true });
  });

  it('never lets the author review or release', () => {
    expect(assertNotAuthor({ authorUserId: 'a', actorUserId: 'a', action: 'review' }).ok).toBe(
      false,
    );
    expect(assertNotAuthor({ authorUserId: 'a', actorUserId: 'a', action: 'release' }).ok).toBe(
      false,
    );
    expect(assertNotAuthor({ authorUserId: 'a', actorUserId: 'b', action: 'release' }).ok).toBe(
      true,
    );
  });

  it('derives revision states: released is frozen, older versions are superseded', () => {
    const report = { currentVersion: 3, releasedVersion: 2, reportStatus: 'draft' as const };
    expect(revisionState({ ...report, version: 1 })).toBe('superseded');
    expect(revisionState({ ...report, version: 2 })).toBe('released');
    expect(revisionState({ ...report, version: 3 })).toBe('draft');
    expect(
      revisionState({
        version: 1,
        currentVersion: 1,
        releasedVersion: null,
        reportStatus: 'in_review',
      }),
    ).toBe('in_review');
  });

  it('allows new revisions only in editable states and starts a new draft after release', () => {
    expect(canAddRevision('draft')).toEqual({
      ok: true,
      nextStatus: 'draft',
      supersedesRelease: false,
    });
    expect(canAddRevision('changes_requested')).toEqual({
      ok: true,
      nextStatus: 'changes_requested',
      supersedesRelease: false,
    });
    expect(canAddRevision('released')).toEqual({
      ok: true,
      nextStatus: 'draft',
      supersedesRelease: true,
    });
    expect(canAddRevision('in_review').ok).toBe(false);
    expect(canAddRevision('approved').ok).toBe(false);
    expect(canAddRevision('superseded').ok).toBe(false);
  });

  it('uses the shared report machine for transitions', () => {
    expect(reportTransition('draft', 'in_review', 'staff').ok).toBe(true);
    expect(reportTransition('draft', 'released', 'staff').ok).toBe(false);
    expect(reportTransition('in_review', 'changes_requested', 'staff').code).toBe(
      'reason_required',
    );
    expect(reportTransition('in_review', 'changes_requested', 'staff', 'Add photos').ok).toBe(true);
    expect(reportTransition('approved', 'released', 'partner').code).toBe('actor_not_allowed');
  });
});

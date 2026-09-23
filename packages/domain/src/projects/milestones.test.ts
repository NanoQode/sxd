import { describe, expect, it } from 'vitest';
import { evaluateMilestoneAction, milestoneMachine, summarizeMilestones } from './milestones';

describe('milestone actions are distinct', () => {
  it('recording progress starts a pending milestone but never submits or accepts it', () => {
    expect(
      evaluateMilestoneAction('record_progress', { status: 'pending', percentComplete: 10 }),
    ).toEqual({
      ok: true,
      nextStatus: 'in_progress',
    });
    expect(
      evaluateMilestoneAction('record_progress', { status: 'in_progress', percentComplete: 100 }),
    ).toEqual({
      ok: true,
      nextStatus: 'in_progress',
    });
    expect(
      evaluateMilestoneAction('record_progress', { status: 'submitted', percentComplete: 100 }),
    ).toEqual({
      ok: true,
      nextStatus: 'submitted',
    });
  });

  it('validates the progress percentage', () => {
    for (const pct of [-1, 101, 12.5, undefined]) {
      const r = evaluateMilestoneAction('record_progress', {
        status: 'in_progress',
        percentComplete: pct,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('validation_failed');
    }
  });

  it('customer acceptance requires a submitted milestone regardless of progress', () => {
    expect(evaluateMilestoneAction('accept', { status: 'in_progress' }).ok).toBe(false);
    expect(evaluateMilestoneAction('accept', { status: 'submitted' })).toEqual({
      ok: true,
      nextStatus: 'accepted',
    });
  });

  it('customer rejection needs a reason', () => {
    const noReason = evaluateMilestoneAction('reject', { status: 'submitted' });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.code).toBe('validation_failed');
    expect(
      evaluateMilestoneAction('reject', { status: 'submitted', reason: 'Roof not finished' }),
    ).toEqual({
      ok: true,
      nextStatus: 'rejected',
    });
    expect(evaluateMilestoneAction('rework', { status: 'rejected' })).toEqual({
      ok: true,
      nextStatus: 'in_progress',
    });
  });

  it('finance authorisation requires acceptance and happens at most once', () => {
    expect(evaluateMilestoneAction('finance_authorize', { status: 'submitted' }).ok).toBe(false);
    expect(evaluateMilestoneAction('finance_authorize', { status: 'accepted' })).toEqual({
      ok: true,
      nextStatus: 'accepted',
    });
    const twice = evaluateMilestoneAction('finance_authorize', {
      status: 'accepted',
      financeAuthorizedAt: '2026-09-01T00:00:00Z',
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.code).toBe('already_authorized');
  });

  it('acceptance is terminal in the machine', () => {
    expect(milestoneMachine.terminal).toEqual(['accepted']);
    expect(evaluateMilestoneAction('submit', { status: 'accepted' }).ok).toBe(false);
  });

  it('summarises counts and the next planned date', () => {
    const s = summarizeMilestones([
      { status: 'accepted', plannedDate: '2026-01-01' },
      { status: 'in_progress', plannedDate: '2026-03-01' },
      { status: 'pending', plannedDate: '2026-02-01' },
      { status: 'pending', plannedDate: null },
    ]);
    expect(s.total).toBe(4);
    expect(s.byStatus.pending).toBe(2);
    expect(s.nextPlannedDate).toBe('2026-02-01');
  });
});

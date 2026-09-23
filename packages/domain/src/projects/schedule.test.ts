import { describe, expect, it } from 'vitest';
import { evaluateTransition } from '../workflow/machine';
import { defectMachine, permitStatusAfterEvent, projectMachine } from './lifecycle';
import {
  computeProjectSchedule,
  overallPercentComplete,
  validateScheduleGraph,
  type ScheduleTaskRecord,
} from './schedule';

function task(
  key: string,
  likely: number | null,
  extra: Partial<ScheduleTaskRecord> = {},
): ScheduleTaskRecord {
  return {
    key,
    name: key,
    phase: 'other',
    durationDaysMin: null,
    durationDaysLikely: likely,
    durationDaysMax: null,
    calendarBasis: 'calendar_days',
    leadTimeDays: 0,
    ...extra,
  };
}

describe('schedule adapter delegates to the construction engine', () => {
  it('rejects dependency cycles with the cycle path', () => {
    const v = validateScheduleGraph(
      [task('a', 1), task('b', 1), task('c', 1)],
      [
        { predecessorKey: 'a', successorKey: 'b', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'b', successorKey: 'c', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'c', successorKey: 'a', type: 'finish_to_start', lagDays: 0 },
      ],
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('cycle');
    expect(v.message).toBe('dependency cycle: a -> b -> c -> a');
  });

  it('rejects unknown keys and duplicates', () => {
    expect(
      validateScheduleGraph(
        [task('a', 1)],
        [{ predecessorKey: 'a', successorKey: 'ghost', type: 'finish_to_start', lagDays: 0 }],
      ),
    ).toMatchObject({ ok: false, code: 'unknown_key' });
    expect(validateScheduleGraph([task('a', 1), task('a', 2)], [])).toMatchObject({
      ok: false,
      code: 'duplicate_key',
    });
  });

  it('computes planned dates, the critical path and completion when durations are known', () => {
    const c = computeProjectSchedule({
      tasks: [task('a', 5), task('b', 10), task('c', 4), task('d', 3)],
      dependencies: [
        { predecessorKey: 'a', successorKey: 'b', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'a', successorKey: 'c', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'b', successorKey: 'd', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'c', successorKey: 'd', type: 'finish_to_start', lagDays: 0 },
      ],
      startDate: '2026-10-05',
      workingCalendar: { weekend: [], holidays: [] },
    });
    expect(c.completionDate).toBe('2026-10-22');
    expect(c.criticalPath).toEqual(['a', 'b', 'd']);
    expect(c.planned.get('c')).toEqual({ plannedStart: '2026-10-10', plannedFinish: '2026-10-13' });
    expect(c.calendarSource).toBe('provided');
  });

  it('never invents a completion date when a duration is unknown', () => {
    const c = computeProjectSchedule({
      tasks: [task('a', 5), task('b', null), task('c', 2)],
      dependencies: [
        { predecessorKey: 'a', successorKey: 'b', type: 'finish_to_start', lagDays: 0 },
        { predecessorKey: 'b', successorKey: 'c', type: 'finish_to_start', lagDays: 0 },
      ],
      startDate: '2026-10-05',
    });
    expect(c.completionDate).toBeNull();
    expect(c.criticalPath).toEqual([]);
    expect(c.missingInputs.map((m) => m.taskKey)).toEqual(['b', 'c']);
    expect(c.planned.get('a')).toBeDefined();
    expect(c.calendarSource).toBe('saturday_sunday_convention');
  });

  it('averages percent complete', () => {
    expect(overallPercentComplete([])).toBeNull();
    expect(
      overallPercentComplete([
        { percentComplete: 100 },
        { percentComplete: 50 },
        { percentComplete: 0 },
      ]),
    ).toBe(50);
  });
});

describe('lifecycle machines', () => {
  it('requires a reason to put a project on hold or cancel it', () => {
    expect(
      evaluateTransition(projectMachine, { from: 'active', to: 'on_hold', actor: 'staff' }).ok,
    ).toBe(false);
    expect(
      evaluateTransition(projectMachine, {
        from: 'active',
        to: 'on_hold',
        actor: 'staff',
        reason: 'Funding',
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(projectMachine, { from: 'planning', to: 'completed', actor: 'staff' }).ok,
    ).toBe(false);
    expect(
      evaluateTransition(projectMachine, { from: 'active', to: 'active', actor: 'customer' }).ok,
    ).toBe(false);
  });

  it('routes defects through resolution, verification and closure', () => {
    expect(
      evaluateTransition(defectMachine, { from: 'open', to: 'verified', actor: 'staff' }).ok,
    ).toBe(false);
    expect(
      evaluateTransition(defectMachine, { from: 'resolved', to: 'verified', actor: 'staff' }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(defectMachine, { from: 'resolved', to: 'verified', actor: 'customer' }).ok,
    ).toBe(false);
    expect(
      evaluateTransition(defectMachine, { from: 'resolved', to: 'disputed', actor: 'customer' }),
    ).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('moves permit status only through valid events and keeps decided applications closed', () => {
    expect(permitStatusAfterEvent('preparing', 'submitted')).toEqual({
      ok: true,
      status: 'submitted',
      changed: true,
    });
    expect(permitStatusAfterEvent('preparing', 'query_raised').ok).toBe(false);
    expect(permitStatusAfterEvent('submitted', 'query_raised')).toEqual({
      ok: true,
      status: 'query_raised',
      changed: true,
    });
    expect(permitStatusAfterEvent('query_raised', 'resubmitted').ok).toBe(true);
    expect(permitStatusAfterEvent('resubmitted', 'approved')).toEqual({
      ok: true,
      status: 'approved',
      changed: true,
    });
    expect(permitStatusAfterEvent('approved', 'note')).toEqual({
      ok: true,
      status: 'approved',
      changed: false,
    });
    expect(permitStatusAfterEvent('approved', 'submitted').ok).toBe(false);
    expect(permitStatusAfterEvent('submitted', 'fee_paid')).toEqual({
      ok: true,
      status: 'submitted',
      changed: false,
    });
  });
});

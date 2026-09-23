import { describe, expect, it } from 'vitest';
import type {
  ComputeScheduleInput,
  ConstructionTask,
  Schedule,
  ScheduleResult,
  TaskDependency,
} from './construction';
import {
  buildGraph,
  computeSchedule,
  diffBaseline,
  pertEstimate,
  templateFromSeed,
} from './construction';

const NO_WEEKEND = { weekend: [] as number[], holidays: [] as string[] };
const SAT_SUN = { weekend: [6, 7], holidays: [] as string[] };

function task(
  key: string,
  likely: number | null,
  overrides: Partial<ConstructionTask> = {},
): ConstructionTask {
  return {
    key,
    name: key,
    phase: 'other',
    duration: { likely },
    calendar: 'working_days',
    ...overrides,
  };
}

function fs(predecessor: string, successor: string, lagDays = 0): TaskDependency {
  return { predecessor, successor, type: 'finish_to_start', lagDays };
}

function expectSchedule(result: ScheduleResult): Schedule {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result.error)}`);
  if (!result.canComputeCompletionDate) {
    throw new Error(
      `expected computable schedule, missing ${JSON.stringify(result.missingInputs)}`,
    );
  }
  return result.schedule;
}

function byKey(schedule: Schedule, key: string) {
  const found = schedule.tasks.find((t) => t.key === key);
  if (!found) throw new Error(`no task ${key}`);
  return found;
}

describe('buildGraph', () => {
  it('rejects a dependency cycle and reports its path', () => {
    const result = buildGraph(
      [task('a', 1), task('b', 1), task('c', 1)],
      [fs('a', 'b'), fs('b', 'c'), fs('c', 'a')],
    );
    expect(result).toEqual({ ok: false, error: { code: 'cycle', path: ['a', 'b', 'c', 'a'] } });
  });

  it('reports a self-dependency as a one-step cycle', () => {
    const result = buildGraph([task('a', 1)], [fs('a', 'a')]);
    expect(result).toEqual({ ok: false, error: { code: 'cycle', path: ['a', 'a'] } });
  });

  it('rejects duplicate keys', () => {
    const result = buildGraph([task('a', 1), task('a', 2)], []);
    expect(result).toEqual({ ok: false, error: { code: 'duplicate_key', keys: ['a'] } });
  });

  it('rejects dependencies on unknown keys', () => {
    const result = buildGraph([task('a', 1)], [fs('a', 'ghost')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_key');
    expect(result.error.code === 'unknown_key' && result.error.keys).toEqual(['ghost']);
  });

  it('orders tasks topologically, keeping input order for parallel tasks', () => {
    const result = buildGraph(
      [task('d', 1), task('b', 1), task('c', 1), task('a', 1)],
      [fs('a', 'b'), fs('a', 'c'), fs('b', 'd'), fs('c', 'd')],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.order).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('computeSchedule: passes, float and critical path', () => {
  const network: ComputeScheduleInput = {
    tasks: [
      task('A', 5, { calendar: 'calendar_days' }),
      task('B', 10, { calendar: 'calendar_days' }),
      task('C', 4, { calendar: 'calendar_days' }),
      task('D', 3, { calendar: 'calendar_days' }),
    ],
    deps: [fs('A', 'B'), fs('A', 'C'), fs('B', 'D'), fs('C', 'D')],
    startDate: '2026-10-05',
    workingCalendar: NO_WEEKEND,
    durationBasis: 'likely',
  };

  it('computes early and late dates for parallel branches', () => {
    const schedule = expectSchedule(computeSchedule(network));
    expect(byKey(schedule, 'A')).toMatchObject({
      earlyStart: '2026-10-05',
      earlyFinish: '2026-10-09',
    });
    expect(byKey(schedule, 'B')).toMatchObject({
      earlyStart: '2026-10-10',
      earlyFinish: '2026-10-19',
    });
    expect(byKey(schedule, 'C')).toMatchObject({
      earlyStart: '2026-10-10',
      earlyFinish: '2026-10-13',
      lateStart: '2026-10-16',
      lateFinish: '2026-10-19',
    });
    expect(byKey(schedule, 'D')).toMatchObject({
      earlyStart: '2026-10-20',
      earlyFinish: '2026-10-22',
    });
    expect(schedule.completionDate).toBe('2026-10-22');
  });

  it('identifies the zero-float chain as the critical path and floats the short branch', () => {
    const schedule = expectSchedule(computeSchedule(network));
    expect(schedule.criticalPath).toEqual(['A', 'B', 'D']);
    expect(byKey(schedule, 'C').totalFloatDays).toBe(6);
    expect(byKey(schedule, 'C').isCritical).toBe(false);
    expect(byKey(schedule, 'B').totalFloatDays).toBe(0);
  });

  it('lists parallel activities as concurrent tasks', () => {
    const schedule = expectSchedule(computeSchedule(network));
    expect(byKey(schedule, 'B').concurrentWith).toEqual(['C']);
    expect(byKey(schedule, 'C').concurrentWith).toEqual(['B']);
    expect(byKey(schedule, 'A').concurrentWith).toEqual([]);
  });
});

describe('computeSchedule: working-day calendar', () => {
  it('skips weekends and a holiday for working_days tasks', () => {
    const schedule = expectSchedule(
      computeSchedule({
        tasks: [task('brief', 5), task('survey', 3)],
        deps: [fs('brief', 'survey')],
        startDate: '2026-10-05',
        workingCalendar: { weekend: [6, 7], holidays: ['2026-10-12'] },
        durationBasis: 'likely',
      }),
    );
    // Mon 5 .. Fri 9 October; Sat/Sun skipped; Mon 12 is a holiday.
    expect(byKey(schedule, 'brief')).toMatchObject({
      earlyStart: '2026-10-05',
      earlyFinish: '2026-10-09',
    });
    expect(byKey(schedule, 'survey')).toMatchObject({
      earlyStart: '2026-10-13',
      earlyFinish: '2026-10-15',
    });
    expect(schedule.completionDate).toBe('2026-10-15');
  });

  it('starts a working_days task on the first working day on or after the project start', () => {
    const schedule = expectSchedule(
      computeSchedule({
        tasks: [task('brief', 1)],
        deps: [],
        startDate: '2026-10-03', // Saturday
        workingCalendar: SAT_SUN,
        durationBasis: 'likely',
      }),
    );
    expect(byKey(schedule, 'brief').earlyStart).toBe('2026-10-05');
  });

  it('counts calendar_days tasks through the weekend', () => {
    const schedule = expectSchedule(
      computeSchedule({
        tasks: [task('cure', 7, { calendar: 'calendar_days' })],
        deps: [],
        startDate: '2026-10-05',
        workingCalendar: SAT_SUN,
        durationBasis: 'likely',
      }),
    );
    expect(byKey(schedule, 'cure').earlyFinish).toBe('2026-10-11');
  });
});

describe('computeSchedule: dependency types and lags', () => {
  const base = {
    startDate: '2026-10-05',
    workingCalendar: SAT_SUN,
    durationBasis: 'likely' as const,
  };

  it('applies finish-to-start lag in working days', () => {
    const schedule = expectSchedule(
      computeSchedule({ ...base, tasks: [task('P', 5), task('S', 2)], deps: [fs('P', 'S', 2)] }),
    );
    // P finishes Fri 9 Oct; lag Mon 12, Tue 13; S starts Wed 14 Oct.
    expect(byKey(schedule, 'S')).toMatchObject({
      earlyStart: '2026-10-14',
      earlyFinish: '2026-10-15',
    });
  });

  it('applies start-to-start with lag', () => {
    const schedule = expectSchedule(
      computeSchedule({
        ...base,
        tasks: [task('P', 5), task('S', 2)],
        deps: [{ predecessor: 'P', successor: 'S', type: 'start_to_start', lagDays: 1 }],
      }),
    );
    expect(byKey(schedule, 'S')).toMatchObject({
      earlyStart: '2026-10-06',
      earlyFinish: '2026-10-07',
    });
    expect(byKey(schedule, 'P').isCritical).toBe(true);
  });

  it('applies finish-to-finish so the successor finishes no earlier than the predecessor plus lag', () => {
    const schedule = expectSchedule(
      computeSchedule({
        ...base,
        tasks: [task('P', 5), task('S', 2)],
        deps: [{ predecessor: 'P', successor: 'S', type: 'finish_to_finish', lagDays: 1 }],
      }),
    );
    // P finishes Fri 9 Oct; S must finish one working day later (Mon 12) and needs 2 working days.
    expect(byKey(schedule, 'S')).toMatchObject({
      earlyStart: '2026-10-09',
      earlyFinish: '2026-10-12',
    });
    expect(schedule.completionDate).toBe('2026-10-12');
  });

  it('honours lead time as a calendar-day gap before the task may start', () => {
    const schedule = expectSchedule(
      computeSchedule({
        ...base,
        tasks: [task('order', 1), task('install', 2, { leadTimeDays: 14 })],
        deps: [fs('order', 'install')],
      }),
    );
    // order: Mon 5 Oct; released Tue 6 Oct + 14 calendar days = Tue 20 Oct.
    expect(byKey(schedule, 'install')).toMatchObject({
      earlyStart: '2026-10-20',
      leadTimeDays: 14,
    });
  });
});

describe('computeSchedule: missing inputs (seed template)', () => {
  const seed = {
    id: 'illustrative-residential',
    label: 'Editable demonstration schedule; not researched city timing',
    status: 'demo_only',
    tasks: [
      { id: 'brief', duration_working_days: 5, depends_on: [] },
      { id: 'site-investigations', duration_working_days: 10, depends_on: ['brief'] },
      { id: 'design', duration_working_days: 30, depends_on: ['site-investigations'] },
      { id: 'approvals', duration_working_days: null, depends_on: ['design'] },
      { id: 'tender', duration_working_days: 15, depends_on: ['design'] },
      { id: 'construction', duration_working_days: null, depends_on: ['approvals', 'tender'] },
    ],
    missing_inputs: ['jurisdiction_approval_duration', 'scoped_construction_duration'],
  };

  it('converts the seed into working-day tasks and finish-to-start dependencies', () => {
    const template = templateFromSeed(seed);
    expect(template.tasks.map((t) => t.key)).toEqual([
      'brief',
      'site-investigations',
      'design',
      'approvals',
      'tender',
      'construction',
    ]);
    expect(template.tasks.every((t) => t.calendar === 'working_days')).toBe(true);
    expect(template.tasks.find((t) => t.key === 'approvals')?.duration).toEqual({ likely: null });
    expect(template.tasks.find((t) => t.key === 'site-investigations')?.phase).toBe(
      'investigations',
    );
    expect(template.deps).toContainEqual(fs('approvals', 'construction'));
    expect(template.deps).toContainEqual(fs('tender', 'construction'));
    expect(template.deps).toHaveLength(6);
    expect(template.missingInputs).toEqual(seed.missing_inputs);
  });

  it('refuses to fabricate a completion date and returns the computable part', () => {
    const { tasks, deps } = templateFromSeed(seed);
    const result = computeSchedule({
      tasks,
      deps,
      startDate: '2026-10-05',
      workingCalendar: SAT_SUN,
      durationBasis: 'likely',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.canComputeCompletionDate) throw new Error('expected missing inputs');
    expect(result.missingInputs.map((m) => m.taskKey)).toEqual(['approvals', 'construction']);
    expect(result.missingInputs[0]).toMatchObject({ reason: 'duration_missing' });
    expect(result.missingInputs[1]).toMatchObject({
      reason: 'duration_missing',
      blockedBy: ['approvals'],
    });
    expect(result.partial.tasks.map((t) => t.key)).toEqual([
      'brief',
      'site-investigations',
      'design',
      'tender',
    ]);
    expect(result.partial.tasks.find((t) => t.key === 'design')).toMatchObject({
      earlyStart: '2026-10-26',
      earlyFinish: '2026-12-04',
    });
    expect(result.partial.tasks.find((t) => t.key === 'tender')).toMatchObject({
      earlyStart: '2026-12-07',
      earlyFinish: '2026-12-25',
    });
    expect(result.partial.latestScheduledFinish).toBe('2026-12-25');
  });
});

describe('computeSchedule: scenarios, actuals and basis', () => {
  const chain: ComputeScheduleInput = {
    tasks: [
      task('foundations', 5, { phase: 'foundations' }),
      task('structure', 10, { phase: 'structure' }),
      task('roof', 5, { phase: 'roof' }),
    ],
    deps: [fs('foundations', 'structure'), fs('structure', 'roof')],
    startDate: '2026-10-05',
    workingCalendar: SAT_SUN,
    durationBasis: 'likely',
  };

  it('itemises scenario delays and adds them to the affected task only', () => {
    const baseline = expectSchedule(computeSchedule(chain));
    expect(baseline.completionDate).toBe('2026-10-30');
    expect(baseline.scenarioAdjustments).toEqual([]);

    const delayed = expectSchedule(
      computeSchedule({
        ...chain,
        scenario: { weatherDelayDays: 3, deliveryDelayDays: 0, appliesTo: ['structure'] },
      }),
    );
    expect(delayed.scenarioAdjustments).toEqual([
      { taskKey: 'structure', kind: 'weather', days: 3, calendar: 'working_days' },
    ]);
    expect(delayed.totalScenarioDelayDays).toBe(3);
    expect(byKey(delayed, 'structure')).toMatchObject({
      baseDurationDays: 10,
      scenarioDelayDays: 3,
      durationDays: 13,
      earlyFinish: '2026-10-28',
    });
    expect(byKey(delayed, 'foundations').scenarioDelayDays).toBe(0);
    expect(delayed.completionDate).toBe('2026-11-04');
  });

  it('diffs a baseline against the current schedule with per-task and completion deltas', () => {
    const previous = expectSchedule(computeSchedule(chain));
    const current = expectSchedule(
      computeSchedule({ ...chain, scenario: { weatherDelayDays: 3, appliesTo: ['structure'] } }),
    );
    const diff = diffBaseline(previous, current);
    expect(diff.completion).toEqual({
      previous: '2026-10-30',
      current: '2026-11-04',
      deltaDays: 5,
    });
    expect(diff.tasks.find((t) => t.key === 'structure')).toMatchObject({
      startDeltaDays: 0,
      finishDeltaDays: 5,
      change: 'later',
    });
    expect(diff.tasks.find((t) => t.key === 'roof')).toMatchObject({
      previousStart: '2026-10-26',
      currentStart: '2026-10-29',
      startDeltaDays: 3,
      change: 'later',
    });
    expect(diff.summary).toMatchObject({ unchanged: 1, later: 2, added: 0, removed: 0 });
  });

  it('computes the PERT expected duration and a labelled min/max range', () => {
    expect(pertEstimate({ min: 4, likely: 5, max: 12 })?.expectedDays).toBe(6);
    expect(pertEstimate({ likely: 5 })).toBeNull();

    const schedule = expectSchedule(
      computeSchedule({
        tasks: [
          task('A', 5, { calendar: 'calendar_days', duration: { min: 4, likely: 5, max: 12 } }),
        ],
        deps: [],
        startDate: '2026-10-05',
        workingCalendar: NO_WEEKEND,
        durationBasis: 'likely',
      }),
    );
    expect(byKey(schedule, 'A').pert).toEqual({
      minDays: 4,
      likelyDays: 5,
      maxDays: 12,
      expectedDays: 6,
    });
    expect(schedule.range).toEqual({
      label: 'scenario_range_not_a_promise',
      minBasedCompletionDate: '2026-10-08',
      maxBasedCompletionDate: '2026-10-16',
      expectedBasedCompletionDate: '2026-10-10',
      tasksWithoutRange: [],
    });
  });

  it('omits the range when no task carries min and max figures', () => {
    const schedule = expectSchedule(computeSchedule(chain));
    expect(schedule.range).toBeNull();
  });

  it('uses the requested basis and labels a fallback to the likely figure', () => {
    const schedule = expectSchedule(
      computeSchedule({
        tasks: [
          task('A', 5, { calendar: 'calendar_days', duration: { min: 3, likely: 5, max: 8 } }),
          task('B', 2, { calendar: 'calendar_days' }),
        ],
        deps: [fs('A', 'B')],
        startDate: '2026-10-05',
        workingCalendar: NO_WEEKEND,
        durationBasis: 'max',
      }),
    );
    expect(byKey(schedule, 'A')).toMatchObject({ durationDays: 8, durationSource: 'max' });
    expect(byKey(schedule, 'B')).toMatchObject({ durationDays: 2, durationSource: 'likely' });
    expect(schedule.completionDate).toBe('2026-10-14');
  });

  it('lets actual dates override planned dates', () => {
    const started = expectSchedule(
      computeSchedule({
        ...chain,
        tasks: [
          task('foundations', 5, { actualStart: '2026-10-07' }),
          task('structure', 10),
          task('roof', 5),
        ],
      }),
    );
    expect(byKey(started, 'foundations')).toMatchObject({
      status: 'in_progress',
      earlyStart: '2026-10-07',
      earlyFinish: '2026-10-13',
    });
    expect(byKey(started, 'structure').earlyStart).toBe('2026-10-14');

    const finished = expectSchedule(
      computeSchedule({
        ...chain,
        tasks: [
          task('foundations', 5, { actualStart: '2026-10-05', actualFinish: '2026-10-15' }),
          task('structure', 10),
          task('roof', 5),
        ],
      }),
    );
    expect(byKey(finished, 'foundations')).toMatchObject({
      status: 'complete',
      durationSource: 'actuals',
      durationDays: 9,
      earlyFinish: '2026-10-15',
      isCritical: false,
    });
    expect(byKey(finished, 'structure').earlyStart).toBe('2026-10-16');
    expect(finished.criticalPath).toEqual(['structure', 'roof']);
  });

  it('rejects invalid input with a path', () => {
    const result = computeSchedule({ ...chain, startDate: '2026-13-01' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_input', message: expect.any(String), path: 'startDate' },
    });
    const unknownTarget = computeSchedule({
      ...chain,
      scenario: { weatherDelayDays: 1, appliesTo: ['nope'] },
    });
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.error.code).toBe('invalid_input');
  });
});

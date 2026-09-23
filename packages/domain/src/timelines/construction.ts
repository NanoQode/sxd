import type { CompiledCalendar, WorkingCalendar } from './calendar';
import {
  advanceWorkingDays,
  compileCalendar,
  countWorkingDaysBetween,
  dayNumber,
  isValidIsoDate,
  isoDateFromDayNumber,
  retreatWorkingDays,
  snapForwardToWorkingDay,
  validateWorkingCalendar,
} from './calendar';

/**
 * Construction schedule engine (system A of the timelines specification).
 *
 * Specification, quoted:
 *
 * > Tasks: `{ key, name, phase, duration: { min?, likely, max? }, calendar:
 * > 'working_days'|'calendar_days', leadTimeDays?, accountableParty?,
 * > actualStart?, actualFinish?, assumptionNotes? }`. Dependencies:
 * > `{ predecessor, successor, type: 'finish_to_start'|'start_to_start'|
 * > 'finish_to_finish', lagDays }`.
 * >
 * > `buildGraph(tasks, deps)` validates: unknown keys, duplicate keys, and
 * > dependency cycles (reject with an error object listing the cycle path).
 * >
 * > `computeSchedule(...)`: forward pass (early start/finish) honouring
 * > dependency types and lags, lead times, working-day calendar (skip
 * > weekends/holidays for working_days tasks), backward pass (late
 * > start/finish), total float, critical path (zero float chain), parallel
 * > activities. Scenario delays are explicit additions to the affected tasks
 * > and are itemised in the output (`scenarioAdjustments`). Actuals override
 * > planned dates when present.
 * >
 * > If any task on any path has a null duration, the result is `{ ok: true,
 * > canComputeCompletionDate: false, missingInputs: [...], partial: {...} }`
 * > – never fabricate a duration.
 * >
 * > Baselines: `diffBaseline(previousSchedule, currentSchedule)` returning
 * > per-task start/finish deltas and completion delta; baseline history is
 * > kept by the caller.
 * >
 * > Also compute PERT-style ranges when min/likely/max exist:
 * > expected = (min + 4*likely + max)/6, plus a `range` finish (min-based and
 * > max-based finishes) – labelled as scenario range, not a promise.
 *
 * Date model. Every task occupies the half-open span `[start, finish)` of
 * day boundaries: `start` is the morning of the first day of work and
 * `finish` is the morning after the last day of work. Output dates are
 * inclusive: `earlyFinish` is the last day on which work happens, so a
 * 5-working-day task starting on Monday 2026-10-05 finishes on Friday
 * 2026-10-09 and a finish-to-start successor starts on Monday 2026-10-12.
 * A zero-duration milestone starts and finishes on the same date.
 *
 * Calendar rules. A `working_days` task starts on the first working day on
 * or after its release and consumes working days only; a `calendar_days`
 * task counts every day. Lags are counted in the successor's calendar.
 * `leadTimeDays` is a calendar-day gap between a task's release (the latest
 * of its dependency constraints, or the project start) and the earliest day
 * it may start. Scenario delays are added in the affected task's calendar.
 */

export const CONSTRUCTION_PHASES = [
  'design',
  'investigations',
  'approvals',
  'procurement',
  'site_preparation',
  'foundations',
  'structure',
  'roof',
  'services',
  'finishes',
  'inspection',
  'handover',
  'other',
] as const;
export type ConstructionPhase = (typeof CONSTRUCTION_PHASES)[number];

export const TASK_CALENDARS = ['working_days', 'calendar_days'] as const;
export type TaskCalendar = (typeof TASK_CALENDARS)[number];

export const DEPENDENCY_TYPES = ['finish_to_start', 'start_to_start', 'finish_to_finish'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const DURATION_BASES = ['likely', 'min', 'max'] as const;
export type DurationBasis = (typeof DURATION_BASES)[number];

/** Durations in the task's own calendar units. `null` means "not known". */
export interface TaskDuration {
  min?: number | null;
  likely: number | null;
  max?: number | null;
}

export interface ConstructionTask {
  key: string;
  name: string;
  phase: ConstructionPhase;
  duration: TaskDuration;
  calendar: TaskCalendar;
  /** Calendar days between the task's release and the earliest day it may start. */
  leadTimeDays?: number;
  accountableParty?: string;
  /** ISO date on which work actually started; overrides the planned start. */
  actualStart?: string | null;
  /** ISO date on which work actually finished; overrides the planned finish. */
  actualFinish?: string | null;
  assumptionNotes?: string;
}

export interface TaskDependency {
  predecessor: string;
  successor: string;
  type: DependencyType;
  /** Lag in the successor's calendar units; negative values are leads. */
  lagDays: number;
}

export type GraphError =
  | { code: 'duplicate_key'; keys: string[] }
  | { code: 'unknown_key'; keys: string[]; message: string }
  | { code: 'cycle'; path: string[] };

export interface TaskGraph {
  tasks: ReadonlyMap<string, ConstructionTask>;
  /** Topological order (every predecessor before its successors), stable with respect to input order. */
  order: string[];
  dependencies: TaskDependency[];
  predecessorsOf: ReadonlyMap<string, TaskDependency[]>;
  successorsOf: ReadonlyMap<string, TaskDependency[]>;
}

export type BuildGraphResult = { ok: true; graph: TaskGraph } | { ok: false; error: GraphError };

/**
 * Validates task keys and dependencies and returns the dependency graph.
 * Duplicate keys, references to unknown keys and cycles are rejected; a cycle
 * is reported as its path, e.g. `{ code: 'cycle', path: ['a', 'b', 'a'] }`.
 */
export function buildGraph(tasks: ConstructionTask[], deps: TaskDependency[]): BuildGraphResult {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    if (seen.has(task.key)) {
      if (!duplicates.includes(task.key)) duplicates.push(task.key);
    } else {
      seen.add(task.key);
    }
  }
  if (duplicates.length > 0)
    return { ok: false, error: { code: 'duplicate_key', keys: duplicates } };

  const unknown: string[] = [];
  for (const dep of deps) {
    for (const key of [dep.predecessor, dep.successor]) {
      if (!seen.has(key) && !unknown.includes(key)) unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        code: 'unknown_key',
        keys: unknown,
        message: `Dependencies reference unknown task keys: ${unknown.join(', ')}`,
      },
    };
  }

  const taskMap = new Map<string, ConstructionTask>();
  const predecessorsOf = new Map<string, TaskDependency[]>();
  const successorsOf = new Map<string, TaskDependency[]>();
  for (const task of tasks) {
    taskMap.set(task.key, task);
    predecessorsOf.set(task.key, []);
    successorsOf.set(task.key, []);
  }
  for (const dep of deps) {
    mustGet(successorsOf, dep.predecessor).push(dep);
    mustGet(predecessorsOf, dep.successor).push(dep);
  }

  const cycle = findCycle(
    tasks.map((t) => t.key),
    successorsOf,
  );
  if (cycle) return { ok: false, error: { code: 'cycle', path: cycle } };

  return {
    ok: true,
    graph: {
      tasks: taskMap,
      order: topologicalOrder(
        tasks.map((t) => t.key),
        predecessorsOf,
        successorsOf,
      ),
      dependencies: [...deps],
      predecessorsOf,
      successorsOf,
    },
  };
}

/** Depth-first search; returns the first cycle found as a closed path, or null. */
function findCycle(
  keys: string[],
  successorsOf: ReadonlyMap<string, TaskDependency[]>,
): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of successorsOf.get(key) ?? []) {
      const next = dep.successor;
      const nextState = state.get(next);
      if (nextState === 'visiting') {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (nextState === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };

  for (const key of keys) {
    if (!state.has(key)) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn's algorithm seeded in input order so equal-rank tasks keep their input order. */
function topologicalOrder(
  keys: string[],
  predecessorsOf: ReadonlyMap<string, TaskDependency[]>,
  successorsOf: ReadonlyMap<string, TaskDependency[]>,
): string[] {
  const indegree = new Map<string, number>();
  for (const key of keys) indegree.set(key, (predecessorsOf.get(key) ?? []).length);
  const queue = keys.filter((key) => indegree.get(key) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    order.push(key);
    for (const dep of successorsOf.get(key) ?? []) {
      const remaining = mustGet(indegree, dep.successor) - 1;
      indegree.set(dep.successor, remaining);
      if (remaining === 0) queue.push(dep.successor);
    }
  }
  return order;
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

export type ScenarioDelayKind = 'weather' | 'delivery' | 'scope_change' | 'site_access';

export interface ScenarioDelays {
  weatherDelayDays?: number;
  deliveryDelayDays?: number;
  scopeChangeDays?: number;
  siteAccessDelayDays?: number;
  /** Task keys the delays apply to, or `'all'`. Omitted means `'all'`. */
  appliesTo?: string[] | 'all';
}

/** One itemised scenario addition to one task. */
export interface ScenarioAdjustment {
  taskKey: string;
  kind: ScenarioDelayKind;
  days: number;
  calendar: TaskCalendar;
}

export interface ComputeScheduleInput {
  tasks: ConstructionTask[];
  deps: TaskDependency[];
  /** ISO date (YYYY-MM-DD) before which no task may start (unless actuals say otherwise). */
  startDate: string;
  workingCalendar: WorkingCalendar;
  scenario?: ScenarioDelays;
  durationBasis: DurationBasis;
}

export interface InvalidInputError {
  code: 'invalid_input';
  message: string;
  path?: string;
}

/**
 * Which figure a task's duration came from. `'likely'` under a `'min'` or
 * `'max'` basis means the task had no min/max and its likely figure was used
 * unchanged; the fallback is labelled rather than hidden.
 */
export type DurationSource = 'min' | 'likely' | 'max' | 'pert_expected' | 'actuals';

export type TaskProgressStatus = 'planned' | 'in_progress' | 'complete';

export interface PertEstimate {
  minDays: number;
  likelyDays: number;
  maxDays: number;
  /** (min + 4 * likely + max) / 6 */
  expectedDays: number;
}

export interface ScheduledTask {
  key: string;
  name: string;
  phase: ConstructionPhase;
  calendar: TaskCalendar;
  accountableParty?: string;
  assumptionNotes?: string;
  /** Duration used in this pass, in the task's calendar units (base + scenario delays, or measured from actuals). */
  durationDays: number;
  /** The duration figure chosen by the basis before scenario delays; null when actuals determined the span. */
  baseDurationDays: number | null;
  durationSource: DurationSource;
  scenarioDelayDays: number;
  leadTimeDays: number;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  /** Total float in the task's calendar units; zero or negative means critical. */
  totalFloatDays: number;
  isCritical: boolean;
  status: TaskProgressStatus;
  /** Keys of other tasks whose early windows overlap this one (parallel activities). */
  concurrentWith: string[];
  pert: PertEstimate | null;
}

export interface ScheduleRange {
  /** This is a scenario range derived from the min/max figures, not a promised completion date. */
  label: 'scenario_range_not_a_promise';
  minBasedCompletionDate: string;
  maxBasedCompletionDate: string;
  /** Forward pass with each task's PERT expected duration rounded up to whole days. */
  expectedBasedCompletionDate: string;
  /** Tasks without both min and max; they contribute their basis figure to every bound. */
  tasksWithoutRange: string[];
}

export interface Schedule {
  startDate: string;
  /** Last day of work of the latest-finishing task. */
  completionDate: string;
  durationBasis: DurationBasis;
  workingCalendar: WorkingCalendar;
  tasks: ScheduledTask[];
  /** Keys of critical tasks in topological order. */
  criticalPath: string[];
  scenarioAdjustments: ScenarioAdjustment[];
  totalScenarioDelayDays: number;
  range: ScheduleRange | null;
}

export interface MissingInput {
  taskKey: string;
  reason: 'duration_missing' | 'blocked_by_predecessor';
  detail: string;
  blockedBy?: string[];
}

export interface PartialScheduledTask {
  key: string;
  name: string;
  earlyStart: string;
  earlyFinish: string;
  durationDays: number;
  durationSource: DurationSource;
  scenarioDelayDays: number;
  status: TaskProgressStatus;
}

export interface PartialSchedule {
  startDate: string;
  durationBasis: DurationBasis;
  /** Tasks whose early dates could be computed from known inputs. */
  tasks: PartialScheduledTask[];
  scenarioAdjustments: ScenarioAdjustment[];
  /** Finish of the latest computable task. Not a completion date: unscheduled tasks follow it. */
  latestScheduledFinish: string | null;
}

export type ScheduleResult =
  | { ok: false; error: GraphError | InvalidInputError }
  | { ok: true; canComputeCompletionDate: true; schedule: Schedule }
  | {
      ok: true;
      canComputeCompletionDate: false;
      missingInputs: MissingInput[];
      partial: PartialSchedule;
    };

interface Placement {
  es: number;
  ef: number;
  days: number;
  baseDays: number | null;
  source: DurationSource;
  scenarioDays: number;
  status: TaskProgressStatus;
}

interface ForwardPassResult {
  placed: Map<string, Placement>;
  missing: MissingInput[];
}

type BasisMode = DurationBasis | 'pert_expected';

/** Computes early/late dates, float, critical path and scenario range for a task network. */
export function computeSchedule(input: ComputeScheduleInput): ScheduleResult {
  const invalid = validateInput(input);
  if (invalid) return { ok: false, error: invalid };

  const built = buildGraph(input.tasks, input.deps);
  if (!built.ok) return built;
  const { graph } = built;

  const scenarioError = validateScenario(input.scenario, graph);
  if (scenarioError) return { ok: false, error: scenarioError };

  const calendar = compileCalendar(input.workingCalendar);
  const startDay = dayNumber(input.startDate);
  const scenarioAdjustments = itemiseScenario(graph, input.scenario);
  const adjustmentsByTask = groupAdjustments(scenarioAdjustments);

  const forward = forwardPass(graph, startDay, calendar, input.durationBasis, adjustmentsByTask);
  if (forward.missing.length > 0) {
    return {
      ok: true,
      canComputeCompletionDate: false,
      missingInputs: forward.missing,
      partial: toPartialSchedule(graph, forward.placed, input, scenarioAdjustments),
    };
  }

  const late = backwardPass(graph, forward.placed, calendar);
  const tasks: ScheduledTask[] = [];
  for (const key of graph.order) {
    const task = mustGet(graph.tasks, key);
    const p = mustGet(forward.placed, key);
    const l = mustGet(late, key);
    const totalFloatDays =
      task.calendar === 'working_days'
        ? countWorkingDaysBetween(p.es, l.ls, calendar)
        : l.ls - p.es;
    const isCritical = p.status !== 'complete' && totalFloatDays <= 0;
    tasks.push({
      key,
      name: task.name,
      phase: task.phase,
      calendar: task.calendar,
      ...(task.accountableParty !== undefined ? { accountableParty: task.accountableParty } : {}),
      ...(task.assumptionNotes !== undefined ? { assumptionNotes: task.assumptionNotes } : {}),
      durationDays: p.days,
      baseDurationDays: p.baseDays,
      durationSource: p.source,
      scenarioDelayDays: p.scenarioDays,
      leadTimeDays: task.leadTimeDays ?? 0,
      earlyStart: isoDateFromDayNumber(p.es),
      earlyFinish: finishDate(p.es, p.ef),
      lateStart: isoDateFromDayNumber(l.ls),
      lateFinish: finishDate(l.ls, l.lf),
      totalFloatDays,
      isCritical,
      status: p.status,
      concurrentWith: concurrentTasks(key, graph.order, forward.placed),
      pert: pertEstimate(task.duration),
    });
  }

  let projectFinish = startDay;
  for (const p of forward.placed.values()) projectFinish = Math.max(projectFinish, p.ef);

  return {
    ok: true,
    canComputeCompletionDate: true,
    schedule: {
      startDate: input.startDate,
      completionDate: finishDate(startDay, projectFinish),
      durationBasis: input.durationBasis,
      workingCalendar: input.workingCalendar,
      tasks,
      criticalPath: tasks.filter((t) => t.isCritical).map((t) => t.key),
      scenarioAdjustments,
      totalScenarioDelayDays: scenarioAdjustments.reduce((sum, a) => sum + a.days, 0),
      range: computeRange(graph, forward.placed, startDay, calendar, adjustmentsByTask),
    },
  };
}

function validateInput(input: ComputeScheduleInput): InvalidInputError | null {
  const fail = (message: string, path?: string): InvalidInputError =>
    path === undefined
      ? { code: 'invalid_input', message }
      : { code: 'invalid_input', message, path };

  if (!isValidIsoDate(input.startDate)) {
    return fail('startDate must be an ISO calendar date (YYYY-MM-DD)', 'startDate');
  }
  if (!input.workingCalendar || typeof input.workingCalendar !== 'object') {
    return fail('workingCalendar is required', 'workingCalendar');
  }
  const calendarProblems = validateWorkingCalendar(input.workingCalendar);
  if (calendarProblems.length > 0) return fail(calendarProblems.join('; '), 'workingCalendar');
  if (!(DURATION_BASES as readonly string[]).includes(input.durationBasis)) {
    return fail(`durationBasis must be one of ${DURATION_BASES.join(', ')}`, 'durationBasis');
  }
  if (!Array.isArray(input.tasks)) return fail('tasks must be an array', 'tasks');
  if (!Array.isArray(input.deps)) return fail('deps must be an array', 'deps');

  for (const [i, task] of input.tasks.entries()) {
    const at = `tasks[${i}]`;
    if (typeof task.key !== 'string' || task.key.length === 0) {
      return fail('task key must be a non-empty string', `${at}.key`);
    }
    if (!(CONSTRUCTION_PHASES as readonly string[]).includes(task.phase)) {
      return fail(`unknown phase "${String(task.phase)}"`, `${at}.phase`);
    }
    if (!(TASK_CALENDARS as readonly string[]).includes(task.calendar)) {
      return fail(`unknown calendar "${String(task.calendar)}"`, `${at}.calendar`);
    }
    if (!task.duration || typeof task.duration !== 'object') {
      return fail('duration must be an object', `${at}.duration`);
    }
    const { min, likely, max } = task.duration;
    for (const [name, value] of [
      ['min', min],
      ['likely', likely],
      ['max', max],
    ] as const) {
      if (value !== undefined && value !== null && !(Number.isFinite(value) && value >= 0)) {
        return fail(
          `duration.${name} must be a non-negative number or null`,
          `${at}.duration.${name}`,
        );
      }
    }
    if (isNum(min) && isNum(likely) && min > likely) {
      return fail('duration.min must not exceed duration.likely', `${at}.duration`);
    }
    if (isNum(likely) && isNum(max) && likely > max) {
      return fail('duration.likely must not exceed duration.max', `${at}.duration`);
    }
    if (isNum(min) && isNum(max) && min > max) {
      return fail('duration.min must not exceed duration.max', `${at}.duration`);
    }
    if (
      task.leadTimeDays !== undefined &&
      !(Number.isInteger(task.leadTimeDays) && task.leadTimeDays >= 0)
    ) {
      return fail('leadTimeDays must be a non-negative integer', `${at}.leadTimeDays`);
    }
    if (task.actualStart != null && !isValidIsoDate(task.actualStart)) {
      return fail('actualStart must be an ISO calendar date', `${at}.actualStart`);
    }
    if (task.actualFinish != null && !isValidIsoDate(task.actualFinish)) {
      return fail('actualFinish must be an ISO calendar date', `${at}.actualFinish`);
    }
    if (
      task.actualStart != null &&
      task.actualFinish != null &&
      dayNumber(task.actualFinish) < dayNumber(task.actualStart)
    ) {
      return fail('actualFinish must not be before actualStart', `${at}.actualFinish`);
    }
  }

  for (const [i, dep] of input.deps.entries()) {
    const at = `deps[${i}]`;
    if (!(DEPENDENCY_TYPES as readonly string[]).includes(dep.type)) {
      return fail(`unknown dependency type "${String(dep.type)}"`, `${at}.type`);
    }
    if (!Number.isInteger(dep.lagDays)) return fail('lagDays must be an integer', `${at}.lagDays`);
  }

  if (input.scenario !== undefined) {
    const s = input.scenario;
    for (const [name, value] of [
      ['weatherDelayDays', s.weatherDelayDays],
      ['deliveryDelayDays', s.deliveryDelayDays],
      ['scopeChangeDays', s.scopeChangeDays],
      ['siteAccessDelayDays', s.siteAccessDelayDays],
    ] as const) {
      if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
        return fail(`${name} must be a non-negative integer`, `scenario.${name}`);
      }
    }
    if (s.appliesTo !== undefined && s.appliesTo !== 'all' && !Array.isArray(s.appliesTo)) {
      return fail("appliesTo must be 'all' or an array of task keys", 'scenario.appliesTo');
    }
  }
  return null;
}

function validateScenario(
  scenario: ScenarioDelays | undefined,
  graph: TaskGraph,
): InvalidInputError | null {
  if (!scenario || !Array.isArray(scenario.appliesTo)) return null;
  const unknown = scenario.appliesTo.filter((key) => !graph.tasks.has(key));
  if (unknown.length === 0) return null;
  return {
    code: 'invalid_input',
    message: `scenario.appliesTo references unknown task keys: ${unknown.join(', ')}`,
    path: 'scenario.appliesTo',
  };
}

const SCENARIO_KINDS: ReadonlyArray<{ field: keyof ScenarioDelays; kind: ScenarioDelayKind }> = [
  { field: 'weatherDelayDays', kind: 'weather' },
  { field: 'deliveryDelayDays', kind: 'delivery' },
  { field: 'scopeChangeDays', kind: 'scope_change' },
  { field: 'siteAccessDelayDays', kind: 'site_access' },
];

/** Expands the scenario into one explicit line per (task, delay kind) with a non-zero value. */
function itemiseScenario(
  graph: TaskGraph,
  scenario: ScenarioDelays | undefined,
): ScenarioAdjustment[] {
  if (!scenario) return [];
  const targets =
    scenario.appliesTo === undefined || scenario.appliesTo === 'all'
      ? graph.order
      : graph.order.filter((key) => (scenario.appliesTo as string[]).includes(key));
  const adjustments: ScenarioAdjustment[] = [];
  for (const key of targets) {
    const task = mustGet(graph.tasks, key);
    for (const { field, kind } of SCENARIO_KINDS) {
      const days = scenario[field];
      if (typeof days === 'number' && days > 0) {
        adjustments.push({ taskKey: key, kind, days, calendar: task.calendar });
      }
    }
  }
  return adjustments;
}

function groupAdjustments(adjustments: ScenarioAdjustment[]): Map<string, number> {
  const byTask = new Map<string, number>();
  for (const a of adjustments) byTask.set(a.taskKey, (byTask.get(a.taskKey) ?? 0) + a.days);
  return byTask;
}

/** PERT expected duration when all three figures are present. */
export function pertEstimate(duration: TaskDuration): PertEstimate | null {
  const { min, likely, max } = duration;
  if (!isNum(min) || !isNum(likely) || !isNum(max)) return null;
  return {
    minDays: min,
    likelyDays: likely,
    maxDays: max,
    expectedDays: (min + 4 * likely + max) / 6,
  };
}

function pickDuration(
  task: ConstructionTask,
  mode: BasisMode,
): { days: number; source: DurationSource } | null {
  const { min, likely, max } = task.duration;
  const likelyOrNull = isNum(likely) ? { days: likely, source: 'likely' as const } : null;
  switch (mode) {
    case 'likely':
      return likelyOrNull;
    case 'min':
      return isNum(min) ? { days: min, source: 'min' } : likelyOrNull;
    case 'max':
      return isNum(max) ? { days: max, source: 'max' } : likelyOrNull;
    case 'pert_expected': {
      const pert = pertEstimate(task.duration);
      return pert ? { days: Math.ceil(pert.expectedDays), source: 'pert_expected' } : likelyOrNull;
    }
  }
}

/* Boundary arithmetic in a task's calendar. */

function advance(day: number, n: number, cal: TaskCalendar, wc: CompiledCalendar): number {
  return cal === 'calendar_days' ? day + n : advanceWorkingDays(day, n, wc);
}

/** Latest start boundary from which `d` units fit before `finishBound` (floor inverse of advance). */
function latestStartFor(
  finishBound: number,
  d: number,
  cal: TaskCalendar,
  wc: CompiledCalendar,
): number {
  return cal === 'calendar_days' ? finishBound - d : retreatWorkingDays(finishBound, d, wc);
}

/** Earliest start boundary whose finish after `d` units is not before `finishBound` (ceiling inverse). */
function earliestStartFor(
  finishBound: number,
  d: number,
  cal: TaskCalendar,
  wc: CompiledCalendar,
): number {
  if (cal === 'calendar_days') return finishBound - d;
  const y = retreatWorkingDays(finishBound, d, wc);
  if (advanceWorkingDays(y, d, wc) >= finishBound) return y;
  return snapForwardToWorkingDay(y + 1, wc);
}

const addLag = advance;
const subtractLag = latestStartFor;

function forwardPass(
  graph: TaskGraph,
  startDay: number,
  wc: CompiledCalendar,
  mode: BasisMode,
  adjustmentsByTask: ReadonlyMap<string, number>,
): ForwardPassResult {
  const placed = new Map<string, Placement>();
  const missing: MissingInput[] = [];

  for (const key of graph.order) {
    const task = mustGet(graph.tasks, key);
    const picked = pickDuration(task, mode);
    const scenarioDays = adjustmentsByTask.get(key) ?? 0;
    const days = picked ? picked.days + scenarioDays : null;
    const actualStart = task.actualStart != null ? dayNumber(task.actualStart) : null;
    // Inclusive finish date -> boundary after the last day of work.
    const actualFinish = task.actualFinish != null ? dayNumber(task.actualFinish) + 1 : null;

    if (actualFinish !== null) {
      // Complete: actual dates are authoritative. Without an actual start the
      // start is inferred from the duration, or equals the finish for a
      // task whose duration is unknown (documented, and only affects
      // start-to-start successors of an already finished task).
      const es =
        actualStart ??
        (days !== null ? latestStartFor(actualFinish, days, task.calendar, wc) : actualFinish);
      const measured =
        task.calendar === 'working_days'
          ? countWorkingDaysBetween(es, actualFinish, wc)
          : actualFinish - es;
      placed.set(key, {
        es,
        ef: actualFinish,
        days: measured,
        baseDays: picked?.days ?? null,
        source: 'actuals',
        scenarioDays: 0,
        status: 'complete',
      });
      continue;
    }

    if (days === null) {
      const preds = (graph.predecessorsOf.get(key) ?? []).map((d) => d.predecessor);
      const blockedBy = preds.filter((p) => !placed.has(p));
      missing.push({
        taskKey: key,
        reason: 'duration_missing',
        detail: `Task "${key}" has no ${describeBasis(mode)} duration; supply a duration or actual dates.`,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
      });
      continue;
    }

    if (actualStart !== null) {
      placed.set(key, {
        es: actualStart,
        ef: advance(actualStart, days, task.calendar, wc),
        days,
        baseDays: picked ? picked.days : null,
        source: picked ? picked.source : 'actuals',
        scenarioDays,
        status: 'in_progress',
      });
      continue;
    }

    const preds = graph.predecessorsOf.get(key) ?? [];
    const blockedBy = preds.map((d) => d.predecessor).filter((p) => !placed.has(p));
    if (blockedBy.length > 0) {
      missing.push({
        taskKey: key,
        reason: 'blocked_by_predecessor',
        detail: `Task "${key}" cannot be scheduled until ${blockedBy.join(', ')} can be.`,
        blockedBy,
      });
      continue;
    }

    let release = startDay;
    for (const dep of preds) {
      const p = mustGet(placed, dep.predecessor);
      let candidate: number;
      switch (dep.type) {
        case 'finish_to_start':
          candidate = addLag(p.ef, dep.lagDays, task.calendar, wc);
          break;
        case 'start_to_start':
          candidate = addLag(p.es, dep.lagDays, task.calendar, wc);
          break;
        case 'finish_to_finish':
          candidate = earliestStartFor(
            addLag(p.ef, dep.lagDays, task.calendar, wc),
            days,
            task.calendar,
            wc,
          );
          break;
      }
      release = Math.max(release, candidate);
    }
    release += task.leadTimeDays ?? 0;
    const es = task.calendar === 'working_days' ? snapForwardToWorkingDay(release, wc) : release;
    placed.set(key, {
      es,
      ef: advance(es, days, task.calendar, wc),
      days,
      baseDays: picked ? picked.days : null,
      source: picked ? picked.source : 'actuals',
      scenarioDays,
      status: 'planned',
    });
  }

  return { placed, missing };
}

function backwardPass(
  graph: TaskGraph,
  placed: ReadonlyMap<string, Placement>,
  wc: CompiledCalendar,
): Map<string, { ls: number; lf: number }> {
  let projectFinish = Number.NEGATIVE_INFINITY;
  for (const p of placed.values()) projectFinish = Math.max(projectFinish, p.ef);

  const late = new Map<string, { ls: number; lf: number }>();
  for (const key of [...graph.order].reverse()) {
    const task = mustGet(graph.tasks, key);
    const p = mustGet(placed, key);
    if (p.status === 'complete') {
      late.set(key, { ls: p.es, lf: p.ef });
      continue;
    }
    let lf = projectFinish;
    let lsBound = Number.POSITIVE_INFINITY;
    for (const dep of graph.successorsOf.get(key) ?? []) {
      const successor = mustGet(graph.tasks, dep.successor);
      const sl = mustGet(late, dep.successor);
      const successorRelease = sl.ls - (successor.leadTimeDays ?? 0);
      switch (dep.type) {
        case 'finish_to_start':
          lf = Math.min(lf, subtractLag(successorRelease, dep.lagDays, successor.calendar, wc));
          break;
        case 'start_to_start':
          lsBound = Math.min(
            lsBound,
            subtractLag(successorRelease, dep.lagDays, successor.calendar, wc),
          );
          break;
        case 'finish_to_finish':
          lf = Math.min(lf, subtractLag(sl.lf, dep.lagDays, successor.calendar, wc));
          break;
      }
    }
    const ls = Math.min(latestStartFor(lf, p.days, task.calendar, wc), lsBound);
    late.set(key, { ls, lf: advance(ls, p.days, task.calendar, wc) });
  }
  return late;
}

function computeRange(
  graph: TaskGraph,
  likelyPlaced: ReadonlyMap<string, Placement>,
  startDay: number,
  wc: CompiledCalendar,
  adjustmentsByTask: ReadonlyMap<string, number>,
): ScheduleRange | null {
  const open = graph.order.filter((key) => mustGet(likelyPlaced, key).status !== 'complete');
  const tasksWithoutRange = open.filter(
    (key) => pertEstimate(mustGet(graph.tasks, key).duration) === null,
  );
  if (open.length === 0 || tasksWithoutRange.length === open.length) return null;

  const completionFor = (mode: BasisMode): string | null => {
    const pass = forwardPass(graph, startDay, wc, mode, adjustmentsByTask);
    if (pass.missing.length > 0) return null;
    let finish = Number.NEGATIVE_INFINITY;
    for (const p of pass.placed.values()) finish = Math.max(finish, p.ef);
    return finishDate(startDay, finish);
  };
  const minBased = completionFor('min');
  const maxBased = completionFor('max');
  const expectedBased = completionFor('pert_expected');
  if (minBased === null || maxBased === null || expectedBased === null) return null;
  return {
    label: 'scenario_range_not_a_promise',
    minBasedCompletionDate: minBased,
    maxBasedCompletionDate: maxBased,
    expectedBasedCompletionDate: expectedBased,
    tasksWithoutRange,
  };
}

function toPartialSchedule(
  graph: TaskGraph,
  placed: ReadonlyMap<string, Placement>,
  input: ComputeScheduleInput,
  scenarioAdjustments: ScenarioAdjustment[],
): PartialSchedule {
  const tasks: PartialScheduledTask[] = [];
  let latest = Number.NEGATIVE_INFINITY;
  let latestStart = 0;
  for (const key of graph.order) {
    const p = placed.get(key);
    if (!p) continue;
    const task = mustGet(graph.tasks, key);
    tasks.push({
      key,
      name: task.name,
      earlyStart: isoDateFromDayNumber(p.es),
      earlyFinish: finishDate(p.es, p.ef),
      durationDays: p.days,
      durationSource: p.source,
      scenarioDelayDays: p.scenarioDays,
      status: p.status,
    });
    if (p.ef > latest) {
      latest = p.ef;
      latestStart = p.es;
    }
  }
  return {
    startDate: input.startDate,
    durationBasis: input.durationBasis,
    tasks,
    scenarioAdjustments,
    latestScheduledFinish: tasks.length > 0 ? finishDate(latestStart, latest) : null,
  };
}

function concurrentTasks(
  key: string,
  order: string[],
  placed: ReadonlyMap<string, Placement>,
): string[] {
  const me = mustGet(placed, key);
  return order.filter((other) => {
    if (other === key) return false;
    const o = mustGet(placed, other);
    return me.es < o.ef && o.es < me.ef;
  });
}

/** Inclusive finish date for a `[start, finish)` span; a milestone finishes on its start date. */
function finishDate(start: number, finishBoundary: number): string {
  return isoDateFromDayNumber(finishBoundary > start ? finishBoundary - 1 : start);
}

function describeBasis(mode: BasisMode): string {
  return mode === 'pert_expected' ? 'likely' : mode;
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Internal error: no entry for ${String(key)}`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Seed template                                                              */
/* -------------------------------------------------------------------------- */

export interface SeedTemplateTask {
  id: string;
  /** Null in the seed where the value is genuinely unknown (approvals, construction). */
  duration_working_days: number | null;
  depends_on: string[];
}

export interface SeedScenarioTemplate {
  id?: string;
  label?: string;
  status?: string;
  tasks: SeedTemplateTask[];
  missing_inputs?: string[];
}

export interface TemplateFromSeed {
  tasks: ConstructionTask[];
  deps: TaskDependency[];
  assumptionNotes: string;
  /** The seed's own list of missing inputs, passed through untouched. */
  missingInputs: string[];
}

const SEED_PHASE_HINTS: ReadonlyArray<[RegExp, ConstructionPhase]> = [
  [/investigat|survey|geotech|soil/i, 'investigations'],
  [/brief|design|drawing/i, 'design'],
  [/approval|permit|consent/i, 'approvals'],
  [/tender|procure|bid/i, 'procurement'],
  [/site[-_ ]?prep|clearance|hoarding/i, 'site_preparation'],
  [/foundation|substructure/i, 'foundations'],
  [/roof/i, 'roof'],
  [/finish/i, 'finishes'],
  [/inspect/i, 'inspection'],
  [/handover/i, 'handover'],
];

/**
 * Converts the research seed's `scenario_template` (`{ tasks: [{ id,
 * duration_working_days, depends_on }] }`) into tasks and finish-to-start
 * dependencies on the `working_days` calendar. Null durations stay null so
 * that `computeSchedule` reports them as missing inputs instead of inventing
 * a figure.
 */
export function templateFromSeed(seed: SeedScenarioTemplate): TemplateFromSeed {
  const tasks: ConstructionTask[] = seed.tasks.map((t) => ({
    key: t.id,
    name: humaniseKey(t.id),
    phase: SEED_PHASE_HINTS.find(([re]) => re.test(t.id))?.[1] ?? 'other',
    duration: { likely: t.duration_working_days },
    calendar: 'working_days',
  }));
  const deps: TaskDependency[] = seed.tasks.flatMap((t) =>
    t.depends_on.map((predecessor) => ({
      predecessor,
      successor: t.id,
      type: 'finish_to_start' as const,
      lagDays: 0,
    })),
  );
  const label = seed.label ?? seed.id ?? 'seed template';
  return {
    tasks,
    deps,
    assumptionNotes: `${label}${seed.status ? ` (${seed.status})` : ''}: editable demonstration schedule from the research seed, not researched city timing and unsuitable for a promised completion date.`,
    missingInputs: [...(seed.missing_inputs ?? [])],
  };
}

function humaniseKey(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Baselines                                                                  */
/* -------------------------------------------------------------------------- */

/** The minimum a caller must store per baseline; a full {@link Schedule} satisfies it. */
export interface BaselineSnapshot {
  completionDate: string;
  tasks: Array<{ key: string; earlyStart: string; earlyFinish: string }>;
}

export type BaselineChange = 'unchanged' | 'earlier' | 'later' | 'mixed' | 'added' | 'removed';

export interface TaskBaselineDelta {
  key: string;
  previousStart: string | null;
  currentStart: string | null;
  /** Calendar days; positive when the current start is later than the baseline. */
  startDeltaDays: number | null;
  previousFinish: string | null;
  currentFinish: string | null;
  /** Calendar days; positive when the current finish is later than the baseline. */
  finishDeltaDays: number | null;
  change: BaselineChange;
}

export interface BaselineDiff {
  completion: { previous: string; current: string; deltaDays: number };
  tasks: TaskBaselineDelta[];
  summary: Record<BaselineChange, number>;
}

/**
 * Compares two schedules (or stored snapshots) task by task. Deltas are in
 * calendar days. Baseline history is kept by the caller; this function only
 * compares the two it is given.
 */
export function diffBaseline(previous: BaselineSnapshot, current: BaselineSnapshot): BaselineDiff {
  const prevByKey = new Map(previous.tasks.map((t) => [t.key, t]));
  const currByKey = new Map(current.tasks.map((t) => [t.key, t]));
  const keys = [
    ...current.tasks.map((t) => t.key),
    ...previous.tasks.map((t) => t.key).filter((k) => !currByKey.has(k)),
  ];

  const summary: Record<BaselineChange, number> = {
    unchanged: 0,
    earlier: 0,
    later: 0,
    mixed: 0,
    added: 0,
    removed: 0,
  };
  const tasks: TaskBaselineDelta[] = keys.map((key) => {
    const prev = prevByKey.get(key);
    const curr = currByKey.get(key);
    let change: BaselineChange;
    let startDeltaDays: number | null = null;
    let finishDeltaDays: number | null = null;
    if (prev && curr) {
      startDeltaDays = dayNumber(curr.earlyStart) - dayNumber(prev.earlyStart);
      finishDeltaDays = dayNumber(curr.earlyFinish) - dayNumber(prev.earlyFinish);
      if (startDeltaDays === 0 && finishDeltaDays === 0) change = 'unchanged';
      else if (startDeltaDays >= 0 && finishDeltaDays >= 0) change = 'later';
      else if (startDeltaDays <= 0 && finishDeltaDays <= 0) change = 'earlier';
      else change = 'mixed';
    } else {
      change = curr ? 'added' : 'removed';
    }
    summary[change] += 1;
    return {
      key,
      previousStart: prev?.earlyStart ?? null,
      currentStart: curr?.earlyStart ?? null,
      startDeltaDays,
      previousFinish: prev?.earlyFinish ?? null,
      currentFinish: curr?.earlyFinish ?? null,
      finishDeltaDays,
      change,
    };
  });

  return {
    completion: {
      previous: previous.completionDate,
      current: current.completionDate,
      deltaDays: dayNumber(current.completionDate) - dayNumber(previous.completionDate),
    },
    tasks,
    summary,
  };
}

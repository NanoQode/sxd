import type { WorkingCalendar } from '../timelines/calendar';
import { SATURDAY_SUNDAY_WEEKEND } from '../timelines/calendar';
import type {
  ConstructionPhase,
  ConstructionTask,
  DependencyType,
  GraphError,
  ScheduleResult,
  TaskCalendar,
  TaskDependency,
} from '../timelines/construction';
import { buildGraph, computeSchedule } from '../timelines/construction';

/**
 * Adapter between persisted schedule rows and the construction timeline
 * engine. The engine owns cycle detection, the forward/backward passes and
 * the critical path; this module only maps rows and shapes the results.
 */

export interface ScheduleTaskRecord {
  key: string;
  name: string;
  phase: ConstructionPhase;
  durationDaysMin: number | null;
  durationDaysLikely: number | null;
  durationDaysMax: number | null;
  calendarBasis: TaskCalendar;
  leadTimeDays: number;
  accountableParty?: string | null;
  assumptionNotes?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
}

export interface ScheduleDependencyRecord {
  predecessorKey: string;
  successorKey: string;
  type: DependencyType;
  lagDays: number;
}

export function toConstructionTasks(rows: ScheduleTaskRecord[]): ConstructionTask[] {
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    phase: r.phase,
    duration: { min: r.durationDaysMin, likely: r.durationDaysLikely, max: r.durationDaysMax },
    calendar: r.calendarBasis,
    leadTimeDays: r.leadTimeDays,
    ...(r.accountableParty ? { accountableParty: r.accountableParty } : {}),
    ...(r.assumptionNotes ? { assumptionNotes: r.assumptionNotes } : {}),
    actualStart: r.actualStart ?? null,
    actualFinish: r.actualFinish ?? null,
  }));
}

export function toTaskDependencies(rows: ScheduleDependencyRecord[]): TaskDependency[] {
  return rows.map((r) => ({
    predecessor: r.predecessorKey,
    successor: r.successorKey,
    type: r.type,
    lagDays: r.lagDays,
  }));
}

export type ScheduleGraphValidation =
  | { ok: true }
  | { ok: false; code: GraphError['code']; message: string; details: GraphError };

/** Delegates to the engine's graph builder; cycles are reported with their path. */
export function validateScheduleGraph(
  tasks: ScheduleTaskRecord[],
  deps: ScheduleDependencyRecord[],
): ScheduleGraphValidation {
  const built = buildGraph(toConstructionTasks(tasks), toTaskDependencies(deps));
  if (built.ok) return { ok: true };
  const err = built.error;
  const message =
    err.code === 'cycle'
      ? `dependency cycle: ${err.path.join(' -> ')}`
      : err.code === 'duplicate_key'
        ? `duplicate task keys: ${err.keys.join(', ')}`
        : err.message;
  return { ok: false, code: err.code, message, details: err };
}

/** Saturday/Sunday weekend, no holidays: a named convention echoed in every result. */
export const DEFAULT_WORKING_CALENDAR: WorkingCalendar = {
  weekend: [...SATURDAY_SUNDAY_WEEKEND],
  holidays: [],
};

export interface ComputeProjectScheduleInput {
  tasks: ScheduleTaskRecord[];
  dependencies: ScheduleDependencyRecord[];
  startDate: string;
  workingCalendar?: WorkingCalendar | null;
}

export interface PlannedDates {
  plannedStart: string;
  plannedFinish: string;
}

export interface ProjectScheduleComputation {
  result: ScheduleResult;
  workingCalendar: WorkingCalendar;
  calendarSource: 'provided' | 'saturday_sunday_convention';
  /** Planned dates per task key for every task the engine could place. */
  planned: Map<string, PlannedDates>;
  /** Completion date when every task could be scheduled, otherwise null (unknown, never invented). */
  completionDate: string | null;
  criticalPath: string[];
  missingInputs: Array<{ taskKey: string; reason: string; detail: string }>;
}

export function computeProjectSchedule(
  input: ComputeProjectScheduleInput,
): ProjectScheduleComputation {
  const workingCalendar = input.workingCalendar ?? DEFAULT_WORKING_CALENDAR;
  const result = computeSchedule({
    tasks: toConstructionTasks(input.tasks),
    deps: toTaskDependencies(input.dependencies),
    startDate: input.startDate,
    workingCalendar,
    durationBasis: 'likely',
  });
  const planned = new Map<string, PlannedDates>();
  let completionDate: string | null = null;
  let criticalPath: string[] = [];
  let missingInputs: ProjectScheduleComputation['missingInputs'] = [];
  if (result.ok && result.canComputeCompletionDate) {
    for (const t of result.schedule.tasks) {
      planned.set(t.key, { plannedStart: t.earlyStart, plannedFinish: t.earlyFinish });
    }
    completionDate = result.schedule.completionDate;
    criticalPath = result.schedule.criticalPath;
  } else if (result.ok) {
    for (const t of result.partial.tasks) {
      planned.set(t.key, { plannedStart: t.earlyStart, plannedFinish: t.earlyFinish });
    }
    missingInputs = result.missingInputs.map((m) => ({
      taskKey: m.taskKey,
      reason: m.reason,
      detail: m.detail,
    }));
  }
  return {
    result,
    workingCalendar,
    calendarSource: input.workingCalendar ? 'provided' : 'saturday_sunday_convention',
    planned,
    completionDate,
    criticalPath,
    missingInputs,
  };
}

/** Average of task percentComplete, weighted equally; null without tasks. */
export function overallPercentComplete(tasks: Array<{ percentComplete: number }>): number | null {
  if (tasks.length === 0) return null;
  const sum = tasks.reduce((acc, t) => acc + t.percentComplete, 0);
  return Math.round(sum / tasks.length);
}

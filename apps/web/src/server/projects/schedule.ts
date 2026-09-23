import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  ApiError,
  type ScheduleDto,
  type ScheduleReplace,
  type ScheduleTaskActuals,
  type ScheduleTaskDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type Transaction } from '@simplexd/db';
import {
  computeProjectSchedule,
  validateScheduleGraph,
  type ProjectScheduleComputation,
  type ScheduleDependencyRecord,
  type ScheduleTaskRecord,
} from '@simplexd/domain/projects';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, requireProject, type ProjectAccess } from './access';
import {
  ctxFor,
  invalidTransition,
  userIdOf,
  versionConflict,
  type ServiceOptions,
} from './shared';

type TaskRow = typeof schema.scheduleTasks.$inferSelect;
type DepRow = typeof schema.taskDependencies.$inferSelect;
type BaselineRow = typeof schema.scheduleBaselines.$inferSelect;

function toRecords(tasks: TaskRow[], deps: DepRow[]) {
  const taskRecords: ScheduleTaskRecord[] = tasks.map((t) => ({
    key: t.key,
    name: t.name,
    phase: t.phase,
    durationDaysMin: t.durationDaysMin,
    durationDaysLikely: t.durationDaysLikely,
    durationDaysMax: t.durationDaysMax,
    calendarBasis: t.calendarBasis,
    leadTimeDays: t.leadTimeDays,
    accountableParty: t.accountableParty,
    assumptionNotes: t.assumptionNotes,
    actualStart: t.actualStart,
    actualFinish: t.actualFinish,
  }));
  const depRecords: ScheduleDependencyRecord[] = deps.map((d) => ({
    predecessorKey: d.predecessorKey,
    successorKey: d.successorKey,
    type: d.type,
    lagDays: d.lagDays,
  }));
  return { taskRecords, depRecords };
}

function toBaselineDto(b: BaselineRow) {
  return {
    id: b.id,
    version: b.version,
    computedFinish: b.computedFinish,
    criticalPath: b.criticalPath ?? [],
    reason: b.reason,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
  };
}

async function loadCurrent(tx: Transaction, access: ProjectAccess) {
  const version = access.project.currentScheduleVersion;
  const tasks = await tx
    .select()
    .from(schema.scheduleTasks)
    .where(
      and(
        eq(schema.scheduleTasks.projectId, access.project.id),
        eq(schema.scheduleTasks.scheduleVersion, version),
      ),
    )
    .orderBy(asc(schema.scheduleTasks.sortOrder), asc(schema.scheduleTasks.key));
  const deps = await tx
    .select()
    .from(schema.taskDependencies)
    .where(
      and(
        eq(schema.taskDependencies.projectId, access.project.id),
        eq(schema.taskDependencies.scheduleVersion, version),
      ),
    );
  const baselines = await tx
    .select()
    .from(schema.scheduleBaselines)
    .where(eq(schema.scheduleBaselines.projectId, access.project.id))
    .orderBy(desc(schema.scheduleBaselines.version));
  return { version, tasks, deps, baselines };
}

function buildDto(
  access: ProjectAccess,
  version: number,
  tasks: TaskRow[],
  deps: DepRow[],
  baselines: BaselineRow[],
  computation: ProjectScheduleComputation | null,
  startDate: string | null,
): ScheduleDto {
  const computedByKey = new Map<string, ScheduleTaskDto['computed']>();
  if (computation?.result.ok && computation.result.canComputeCompletionDate) {
    for (const t of computation.result.schedule.tasks) {
      computedByKey.set(t.key, {
        earlyStart: t.earlyStart,
        earlyFinish: t.earlyFinish,
        lateStart: t.lateStart,
        lateFinish: t.lateFinish,
        totalFloatDays: t.totalFloatDays,
        isCritical: t.isCritical,
        status: t.status,
      });
    }
  }
  const range =
    computation?.result.ok && computation.result.canComputeCompletionDate
      ? computation.result.schedule.range
      : null;
  const current = baselines.find((b) => b.version === version) ?? null;
  return {
    projectId: access.project.id,
    scheduleVersion: version,
    startDate,
    workingCalendar: computation?.workingCalendar ?? { weekend: [6, 7], holidays: [] },
    calendarSource: computation?.calendarSource ?? 'saturday_sunday_convention',
    canComputeCompletionDate: computation?.completionDate !== null && computation !== null,
    completionDate: computation?.completionDate ?? null,
    criticalPath: computation?.criticalPath ?? [],
    missingInputs: computation?.missingInputs ?? [],
    range,
    tasks: tasks.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      phase: t.phase,
      durationDaysMin: t.durationDaysMin,
      durationDaysLikely: t.durationDaysLikely,
      durationDaysMax: t.durationDaysMax,
      calendarBasis: t.calendarBasis,
      leadTimeDays: t.leadTimeDays,
      plannedStart: t.plannedStart,
      plannedFinish: t.plannedFinish,
      actualStart: t.actualStart,
      actualFinish: t.actualFinish,
      percentComplete: t.percentComplete,
      accountableParty: t.accountableParty,
      assumptionNotes: t.assumptionNotes,
      sourceNote: t.sourceNote,
      isMilestone: t.isMilestone,
      sortOrder: t.sortOrder,
      computed: computedByKey.get(t.key) ?? null,
    })),
    dependencies: deps.map((d) => ({
      predecessorKey: d.predecessorKey,
      successorKey: d.successorKey,
      type: d.type,
      lagDays: d.lagDays,
    })),
    baseline: current ? toBaselineDto(current) : null,
    baselines: baselines.map(toBaselineDto),
  };
}

function calendarOf(baseline: BaselineRow | null | undefined) {
  const snap = baseline?.snapshot as {
    workingCalendar?: { weekend: number[]; holidays: string[] };
  } | null;
  return snap?.workingCalendar ?? null;
}

export async function getSchedule(
  identity: RequestIdentity,
  projectId: string,
): Promise<ScheduleDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const { version, tasks, deps, baselines } = await loadCurrent(tx, access);
    const startDate = access.project.startDate;
    let computation: ProjectScheduleComputation | null = null;
    if (tasks.length > 0 && startDate) {
      const { taskRecords, depRecords } = toRecords(tasks, deps);
      const current = baselines.find((b) => b.version === version);
      computation = computeProjectSchedule({
        tasks: taskRecords,
        dependencies: depRecords,
        startDate,
        workingCalendar: calendarOf(current),
      });
    }
    return buildDto(access, version, tasks, deps, baselines, computation, startDate);
  });
}

/**
 * Replaces the schedule as a new version, computes planned dates and the
 * critical path with the construction engine and stores an append-only
 * baseline snapshot. Cycles are rejected before anything is written.
 */
export async function replaceSchedule(
  identity: RequestIdentity,
  projectId: string,
  input: ScheduleReplace,
  options: ServiceOptions = {},
): Promise<ScheduleDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    const p = access.project;
    if (p.status === 'archived') throw invalidTransition('archived projects are read-only');
    const startDate = input.startDate ?? p.startDate;
    if (!startDate)
      throw new ApiError(
        'validation_failed',
        'startDate is required: the project has no start date',
      );
    const taskRecords: ScheduleTaskRecord[] = input.tasks.map((t) => ({
      key: t.key,
      name: t.name,
      phase: t.phase,
      durationDaysMin: t.durationDaysMin ?? null,
      durationDaysLikely: t.durationDaysLikely,
      durationDaysMax: t.durationDaysMax ?? null,
      calendarBasis: t.calendarBasis,
      leadTimeDays: t.leadTimeDays,
      accountableParty: t.accountableParty,
      assumptionNotes: t.assumptionNotes ?? null,
      actualStart: t.actualStart ?? null,
      actualFinish: t.actualFinish ?? null,
    }));
    const graph = validateScheduleGraph(taskRecords, input.dependencies);
    if (!graph.ok) {
      throw new ApiError('validation_failed', graph.message, { details: graph.details });
    }
    const computation = computeProjectSchedule({
      tasks: taskRecords,
      dependencies: input.dependencies,
      startDate,
      workingCalendar: input.workingCalendar ?? null,
    });
    if (!computation.result.ok) {
      throw new ApiError(
        'validation_failed',
        computation.result.error.code === 'invalid_input'
          ? computation.result.error.message
          : 'schedule could not be built',
        { details: computation.result.error },
      );
    }
    const previousVersion = p.currentScheduleVersion;
    const hasCurrent =
      (
        await tx
          .select({ id: schema.scheduleTasks.id })
          .from(schema.scheduleTasks)
          .where(
            and(
              eq(schema.scheduleTasks.projectId, projectId),
              eq(schema.scheduleTasks.scheduleVersion, previousVersion),
            ),
          )
          .limit(1)
      ).length > 0;
    const version = hasCurrent ? previousVersion + 1 : previousVersion;
    await tx.insert(schema.scheduleTasks).values(
      input.tasks.map((t, i) => ({
        projectId,
        scheduleVersion: version,
        key: t.key,
        name: t.name,
        phase: t.phase,
        durationDaysMin: t.durationDaysMin ?? null,
        durationDaysLikely: t.durationDaysLikely,
        durationDaysMax: t.durationDaysMax ?? null,
        calendarBasis: t.calendarBasis,
        leadTimeDays: t.leadTimeDays,
        plannedStart: computation.planned.get(t.key)?.plannedStart ?? null,
        plannedFinish: computation.planned.get(t.key)?.plannedFinish ?? null,
        actualStart: t.actualStart ?? null,
        actualFinish: t.actualFinish ?? null,
        percentComplete: t.percentComplete,
        accountableParty: t.accountableParty,
        assumptionNotes: t.assumptionNotes ?? null,
        sourceNote: t.sourceNote ?? null,
        isMilestone: t.isMilestone,
        sortOrder: t.sortOrder ?? i,
      })),
    );
    if (input.dependencies.length > 0) {
      await tx.insert(schema.taskDependencies).values(
        input.dependencies.map((d) => ({
          projectId,
          scheduleVersion: version,
          predecessorKey: d.predecessorKey,
          successorKey: d.successorKey,
          type: d.type,
          lagDays: d.lagDays,
        })),
      );
    }
    const snapshot = computation.result.canComputeCompletionDate
      ? {
          workingCalendar: computation.workingCalendar,
          calendarSource: computation.calendarSource,
          schedule: computation.result.schedule,
        }
      : {
          workingCalendar: computation.workingCalendar,
          calendarSource: computation.calendarSource,
          partial: computation.result.partial,
          missingInputs: computation.missingInputs,
        };
    const [baseline] = await tx
      .insert(schema.scheduleBaselines)
      .values({
        projectId,
        version,
        snapshot,
        criticalPath: computation.criticalPath,
        computedFinish: computation.completionDate,
        reason: input.reason ?? null,
        createdBy: actorId,
      })
      .returning();
    const [updated] = await tx
      .update(schema.projects)
      .set({
        currentScheduleVersion: version,
        startDate,
        forecastCompletionDate: computation.completionDate,
        version: p.version + 1,
      })
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.version, p.version)))
      .returning();
    if (!updated) throw versionConflict(p.version);
    await recordAudit(tx, identity, {
      action: 'schedule.baselined',
      entityType: 'project',
      entityId: projectId,
      organizationId: p.organizationId,
      before: {
        scheduleVersion: previousVersion,
        forecastCompletionDate: p.forecastCompletionDate,
      },
      after: {
        scheduleVersion: version,
        forecastCompletionDate: computation.completionDate,
        criticalPath: computation.criticalPath,
        missingInputs: computation.missingInputs.map((m) => m.taskKey),
      },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    const refreshed = { ...access, project: updated };
    const { tasks, deps, baselines } = await loadCurrent(tx, refreshed);
    return buildDto(
      refreshed,
      version,
      tasks,
      deps,
      baselines.length ? baselines : [baseline!],
      computation,
      startDate,
    );
  });
}

/** Records actual start/finish and percent complete for one task and refreshes forecast dates. */
export async function recordTaskActuals(
  identity: RequestIdentity,
  projectId: string,
  key: string,
  input: ScheduleTaskActuals,
  options: ServiceOptions = {},
): Promise<ScheduleDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [
      { staff: 'projects.manage' },
      { staff: 'milestones.record_progress' },
    ]);
    const p = access.project;
    const { version, tasks, deps, baselines } = await loadCurrent(tx, access);
    const task = tasks.find((t) => t.key === key);
    if (!task) throw new ApiError('not_found', 'schedule task not found');
    const actualStart = input.actualStart !== undefined ? input.actualStart : task.actualStart;
    const actualFinish = input.actualFinish !== undefined ? input.actualFinish : task.actualFinish;
    if (actualStart && actualFinish && actualFinish < actualStart) {
      throw new ApiError('validation_failed', 'actualFinish must not be before actualStart');
    }
    const percentComplete = input.percentComplete ?? (actualFinish ? 100 : task.percentComplete);
    await tx
      .update(schema.scheduleTasks)
      .set({ actualStart, actualFinish, percentComplete })
      .where(eq(schema.scheduleTasks.id, task.id));
    const updatedTasks = tasks.map((t) =>
      t.id === task.id ? { ...t, actualStart, actualFinish, percentComplete } : t,
    );
    let computation: ProjectScheduleComputation | null = null;
    if (p.startDate) {
      const { taskRecords, depRecords } = toRecords(updatedTasks, deps);
      computation = computeProjectSchedule({
        tasks: taskRecords,
        dependencies: depRecords,
        startDate: p.startDate,
        workingCalendar: calendarOf(baselines.find((b) => b.version === version)),
      });
      for (const t of updatedTasks) {
        const planned = computation.planned.get(t.key);
        if (
          planned &&
          (planned.plannedStart !== t.plannedStart || planned.plannedFinish !== t.plannedFinish)
        ) {
          await tx
            .update(schema.scheduleTasks)
            .set({ plannedStart: planned.plannedStart, plannedFinish: planned.plannedFinish })
            .where(eq(schema.scheduleTasks.id, t.id));
          t.plannedStart = planned.plannedStart;
          t.plannedFinish = planned.plannedFinish;
        }
      }
      if (computation.completionDate && computation.completionDate !== p.forecastCompletionDate) {
        await tx
          .update(schema.projects)
          .set({ forecastCompletionDate: computation.completionDate, version: p.version + 1 })
          .where(and(eq(schema.projects.id, projectId), eq(schema.projects.version, p.version)));
        access.project = {
          ...p,
          forecastCompletionDate: computation.completionDate,
          version: p.version + 1,
        };
      }
    }
    await recordAudit(tx, identity, {
      action: 'schedule.task_actuals_recorded',
      entityType: 'schedule_task',
      entityId: task.id,
      organizationId: p.organizationId,
      before: {
        actualStart: task.actualStart,
        actualFinish: task.actualFinish,
        percentComplete: task.percentComplete,
      },
      after: { actualStart, actualFinish, percentComplete },
      correlationId: options.correlationId,
    });
    return buildDto(access, version, updatedTasks, deps, baselines, computation, p.startDate);
  });
}

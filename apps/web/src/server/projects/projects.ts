import 'server-only';
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type BudgetVarianceDto,
  type Page,
  type ProjectCreate,
  type ProjectDto,
  type ProjectListQuery,
  type ProjectOverviewDto,
  type ProjectTransition,
  type ProjectUpdate,
  type TeamMemberDto,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizeStaff } from '@simplexd/domain/authz';
import {
  UNRESOLVED_DEFECT_STATES,
  budgetVarianceToJson,
  computeBudgetVariance,
  overallPercentComplete,
  projectMachine,
  summarizeMilestones,
  type MilestoneState,
} from '@simplexd/domain/projects';
import { evaluateTransition } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, assignedProjectIds, requireProject, type ProjectRow } from './access';
import {
  assertVersion,
  ctxFor,
  decodeCursor,
  invalidTransition,
  isBroadStaff,
  iso,
  pageSlice,
  userIdOf,
  versionConflict,
  type ServiceOptions,
} from './shared';

export function toProjectDto(p: ProjectRow): ProjectDto {
  return {
    id: p.id,
    organizationId: p.organizationId,
    serviceRequestId: p.serviceRequestId,
    propertyId: p.propertyId,
    marketId: p.marketId,
    name: p.name,
    kind: p.kind,
    status: p.status,
    description: p.description,
    approvedBudgetVersionId: p.approvedBudgetVersionId,
    currentScheduleVersion: p.currentScheduleVersion,
    startDate: p.startDate,
    targetCompletionDate: p.targetCompletionDate,
    forecastCompletionDate: p.forecastCompletionDate,
    pmUserId: p.pmUserId,
    customerContactUserId: p.customerContactUserId,
    grossFloorAreaM2: p.grossFloorAreaM2,
    version: p.version,
    createdBy: p.createdBy,
    archivedAt: iso(p.archivedAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function assertUserExists(tx: Transaction, id: string, label: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, id));
  if (rows.length === 0) throw new ApiError('validation_failed', `${label} does not exist`);
}

async function assertSameOrganization(
  tx: Transaction,
  input: Pick<ProjectCreate, 'serviceRequestId' | 'propertyId' | 'marketId'>,
  organizationId: string,
): Promise<void> {
  if (input.serviceRequestId) {
    const [sr] = await tx
      .select({ organizationId: schema.serviceRequests.organizationId })
      .from(schema.serviceRequests)
      .where(eq(schema.serviceRequests.id, input.serviceRequestId));
    if (!sr || sr.organizationId !== organizationId) {
      throw new ApiError(
        'validation_failed',
        'serviceRequestId must belong to the same organisation',
      );
    }
  }
  if (input.propertyId) {
    const [prop] = await tx
      .select({ organizationId: schema.properties.organizationId })
      .from(schema.properties)
      .where(eq(schema.properties.id, input.propertyId));
    if (!prop || prop.organizationId !== organizationId) {
      throw new ApiError('validation_failed', 'propertyId must belong to the same organisation');
    }
  }
  if (input.marketId) {
    const [m] = await tx
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(eq(schema.markets.id, input.marketId));
    if (!m) throw new ApiError('validation_failed', 'marketId does not exist');
  }
}

/** Staff create projects for a customer organisation (`projects.manage`). */
export async function createProject(
  identity: RequestIdentity,
  input: ProjectCreate,
  options: ServiceOptions = {},
): Promise<ProjectDto> {
  const actorId = userIdOf(identity);
  assertAllowed(authorizeStaff(identity.actor, 'projects.manage'));
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId));
    if (!org) throw new ApiError('validation_failed', 'organizationId does not exist');
    await assertSameOrganization(tx, input, input.organizationId);
    // A project manager who creates a project stays assigned to it through pmUserId.
    const pmUserId =
      input.pmUserId ??
      (!isBroadStaff(identity) && identity.actor.staffRoles.includes('project_manager')
        ? actorId
        : null);
    if (pmUserId) await assertUserExists(tx, pmUserId, 'pmUserId');
    if (input.customerContactUserId) {
      const [member] = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, input.customerContactUserId),
            eq(schema.member.organizationId, input.organizationId),
          ),
        );
      if (!member) {
        throw new ApiError(
          'validation_failed',
          'customerContactUserId must be a member of the organisation',
        );
      }
    }
    const [row] = await tx
      .insert(schema.projects)
      .values({
        organizationId: input.organizationId,
        serviceRequestId: input.serviceRequestId ?? null,
        propertyId: input.propertyId ?? null,
        marketId: input.marketId ?? null,
        name: input.name,
        kind: input.kind,
        description: input.description ?? null,
        startDate: input.startDate ?? null,
        targetCompletionDate: input.targetCompletionDate ?? null,
        pmUserId,
        customerContactUserId: input.customerContactUserId ?? null,
        grossFloorAreaM2: input.grossFloorAreaM2 ?? null,
        createdBy: actorId,
      })
      .returning();
    if (input.serviceRequestId) {
      await tx
        .update(schema.serviceRequests)
        .set({ projectId: row!.id })
        .where(
          and(
            eq(schema.serviceRequests.id, input.serviceRequestId),
            isNull(schema.serviceRequests.projectId),
          ),
        );
    }
    await recordAudit(tx, identity, {
      action: 'project.created',
      entityType: 'project',
      entityId: row!.id,
      organizationId: input.organizationId,
      after: {
        name: input.name,
        kind: input.kind,
        pmUserId,
        serviceRequestId: input.serviceRequestId ?? null,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.created',
      aggregateType: 'project',
      aggregateId: row!.id,
      organizationId: input.organizationId,
      actorUserId: actorId,
      payload: { projectId: row!.id, organizationId: input.organizationId, pmUserId },
      correlationId: options.correlationId ?? null,
    });
    return toProjectDto(row!);
  });
}

export async function getProject(identity: RequestIdentity, id: string): Promise<ProjectDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, id, PROJECT_READ_CHECKS);
    return toProjectDto(access.project);
  });
}

/**
 * Lists projects the caller may see: broad staff (and finance) everything with
 * filters; project managers and inspectors only assigned projects; customers
 * their active organisation; partners their accepted/active assignments.
 * Row-level security filters the same way underneath.
 */
export async function listProjects(
  identity: RequestIdentity,
  query: ProjectListQuery,
): Promise<Page<ProjectDto>> {
  const actorId = userIdOf(identity);
  const actor = identity.actor;
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const conditions = [
      query.status ? eq(schema.projects.status, query.status) : undefined,
      query.kind ? eq(schema.projects.kind, query.kind) : undefined,
      query.q ? ilike(schema.projects.name, `%${query.q.replace(/[%_]/g, '')}%`) : undefined,
    ];
    if (actor.staffRoles.length > 0) {
      const listsAll = actor.staffRoles.some((r) =>
        ['super_admin', 'operations_manager', 'finance'].includes(r),
      );
      const projectScoped = actor.staffRoles.some(
        (r) => r === 'project_manager' || r === 'inspector',
      );
      if (!listsAll && !projectScoped) {
        throw new ApiError('forbidden', 'your staff role has no project access');
      }
      if (query.organizationId)
        conditions.push(eq(schema.projects.organizationId, query.organizationId));
      if (!listsAll) {
        const ids = await assignedProjectIds(tx, actorId);
        conditions.push(
          or(
            eq(schema.projects.pmUserId, actorId),
            ids.length > 0 ? inArray(schema.projects.id, ids) : sql`false`,
          ),
        );
      }
    } else if (actor.isPartner && actor.memberships.length === 0) {
      const ids = await assignedProjectIds(tx, actorId);
      // Partners: only accepted/active assignments (proposed ones are not yet theirs).
      const accepted = await tx
        .select({ projectId: schema.assignments.projectId })
        .from(schema.assignments)
        .where(
          and(
            eq(schema.assignments.assigneeUserId, actorId),
            inArray(schema.assignments.status, ['accepted', 'active']),
            ids.length > 0 ? inArray(schema.assignments.projectId, ids) : sql`false`,
          ),
        );
      const acceptedIds = accepted.map((a) => a.projectId).filter((x): x is string => Boolean(x));
      if (acceptedIds.length === 0) return { items: [], nextCursor: null };
      conditions.push(inArray(schema.projects.id, acceptedIds));
    } else {
      const orgId = identity.ctx.organizationId;
      if (!orgId) throw new ApiError('forbidden', 'select an organisation to view its projects');
      assertAllowed(authorizeOrg(actor, 'org.read', { type: 'project', organizationId: orgId }));
      conditions.push(eq(schema.projects.organizationId, orgId));
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      conditions.push(
        or(
          lt(schema.projects.createdAt, cursor.createdAt),
          and(eq(schema.projects.createdAt, cursor.createdAt), lt(schema.projects.id, cursor.id)),
        ),
      );
    }
    const rows = await tx
      .select()
      .from(schema.projects)
      .where(and(...conditions))
      .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    return { items: page.items.map(toProjectDto), nextCursor: page.nextCursor };
  });
}

export async function updateProject(
  identity: RequestIdentity,
  id: string,
  input: ProjectUpdate,
  options: ServiceOptions = {},
): Promise<ProjectDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, id, [{ staff: 'projects.manage' }]);
    const p = access.project;
    assertVersion(p.version, input.expectedVersion);
    if (p.status === 'archived') throw invalidTransition('archived projects are read-only');
    if (input.pmUserId) await assertUserExists(tx, input.pmUserId, 'pmUserId');
    if (input.customerContactUserId) {
      const [member] = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, input.customerContactUserId),
            eq(schema.member.organizationId, p.organizationId),
          ),
        );
      if (!member) {
        throw new ApiError(
          'validation_failed',
          'customerContactUserId must be a member of the organisation',
        );
      }
    }
    const { expectedVersion: _v, ...fields } = input;
    const patch: Partial<typeof schema.projects.$inferInsert> = { version: p.version + 1 };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    const [updated] = await tx
      .update(schema.projects)
      .set(patch)
      .where(and(eq(schema.projects.id, id), eq(schema.projects.version, p.version)))
      .returning();
    if (!updated) throw versionConflict(p.version);
    await recordAudit(tx, identity, {
      action: 'project.updated',
      entityType: 'project',
      entityId: id,
      organizationId: p.organizationId,
      before: pick(p, Object.keys(fields)),
      after: pick(updated, Object.keys(fields)),
      correlationId: options.correlationId,
    });
    return toProjectDto(updated);
  });
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k] ?? null;
  return out;
}

export async function transitionProject(
  identity: RequestIdentity,
  id: string,
  input: ProjectTransition,
  options: ServiceOptions = {},
): Promise<ProjectDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, id, [{ staff: 'projects.manage' }]);
    const p = access.project;
    assertVersion(p.version, input.expectedVersion);
    const decision = evaluateTransition(projectMachine, {
      from: p.status,
      to: input.to,
      actor: 'staff',
      reason: input.reason ?? null,
    });
    if (!decision.ok) {
      throw invalidTransition(decision.message, {
        code: decision.code,
        from: p.status,
        to: input.to,
      });
    }
    const [updated] = await tx
      .update(schema.projects)
      .set({
        status: input.to,
        version: p.version + 1,
        archivedAt: input.to === 'archived' ? new Date() : p.archivedAt,
      })
      .where(and(eq(schema.projects.id, id), eq(schema.projects.version, p.version)))
      .returning();
    if (!updated) throw versionConflict(p.version);
    await recordAudit(tx, identity, {
      action: `project.${input.to}`,
      entityType: 'project',
      entityId: id,
      organizationId: p.organizationId,
      before: { status: p.status, version: p.version },
      after: { status: input.to, version: updated.version },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.status_changed',
      aggregateType: 'project',
      aggregateId: id,
      organizationId: p.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: id,
        organizationId: p.organizationId,
        from: p.status,
        to: input.to,
        customerContactUserId: p.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return toProjectDto(updated);
  });
}

/** Read model computed from real rows: budget, schedule, milestones, defects, reports, team. */
export async function getProjectOverview(
  identity: RequestIdentity,
  id: string,
): Promise<ProjectOverviewDto> {
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, id, PROJECT_READ_CHECKS);
    const p = access.project;

    const approved = p.approvedBudgetVersionId
      ? (
          await tx
            .select()
            .from(schema.budgetVersions)
            .where(eq(schema.budgetVersions.id, p.approvedBudgetVersionId))
        )[0]
      : undefined;
    const totals = await tx
      .select({
        kind: schema.budgetCommitments.kind,
        total: sql<string>`coalesce(sum(${schema.budgetCommitments.amountKobo}), 0)::text`,
      })
      .from(schema.budgetCommitments)
      .where(eq(schema.budgetCommitments.projectId, id))
      .groupBy(schema.budgetCommitments.kind);
    const committed = BigInt(totals.find((t) => t.kind === 'commitment')?.total ?? '0');
    const actual = BigInt(totals.find((t) => t.kind === 'actual')?.total ?? '0');
    const coRows = await tx
      .select({
        status: schema.changeOrders.status,
        delta: sql<string>`coalesce(sum(${schema.changeOrders.amountDeltaKobo}), 0)::text`,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.changeOrders)
      .where(eq(schema.changeOrders.projectId, id))
      .groupBy(schema.changeOrders.status);
    const sumWhere = (statuses: string[]) =>
      coRows
        .filter((r) => statuses.includes(r.status))
        .reduce((acc, r) => acc + BigInt(r.delta), 0n);
    const countWhere = (statuses: string[]) =>
      coRows.filter((r) => statuses.includes(r.status)).reduce((acc, r) => acc + Number(r.n), 0);
    const pendingStatuses = ['submitted', 'staff_review', 'customer_review'];

    const tasks = await tx
      .select({ percentComplete: schema.scheduleTasks.percentComplete })
      .from(schema.scheduleTasks)
      .where(
        and(
          eq(schema.scheduleTasks.projectId, id),
          eq(schema.scheduleTasks.scheduleVersion, p.currentScheduleVersion),
        ),
      );
    const variance = computeBudgetVariance({
      approvedBaseKobo: approved ? approved.totalKobo : null,
      contingencyKobo: approved ? approved.contingencyKobo : 0n,
      committedKobo: committed,
      actualKobo: actual,
      approvedChangeOrderDeltaKobo: sumWhere(['approved']),
      pendingChangeOrderDeltaKobo: sumWhere(pendingStatuses),
      percentComplete: overallPercentComplete(tasks),
    });

    const [baseline] = await tx
      .select()
      .from(schema.scheduleBaselines)
      .where(eq(schema.scheduleBaselines.projectId, id))
      .orderBy(desc(schema.scheduleBaselines.version))
      .limit(1);

    const milestoneRows = await tx
      .select({ status: schema.milestones.status, plannedDate: schema.milestones.plannedDate })
      .from(schema.milestones)
      .where(eq(schema.milestones.projectId, id));
    const milestoneSummary = summarizeMilestones(
      milestoneRows.map((m) => ({
        status: m.status as MilestoneState,
        plannedDate: m.plannedDate,
      })),
    );

    const defectRows = await tx
      .select({ severity: schema.defects.severity, n: sql<number>`count(*)::int` })
      .from(schema.defects)
      .where(
        and(
          eq(schema.defects.projectId, id),
          inArray(schema.defects.status, [...UNRESOLVED_DEFECT_STATES]),
        ),
      )
      .groupBy(schema.defects.severity);
    const bySeverity: Record<string, number> = {};
    let openDefects = 0;
    for (const r of defectRows) {
      bySeverity[r.severity] = Number(r.n);
      openDefects += Number(r.n);
    }

    const [latestReport] = await tx
      .select({
        id: schema.reports.id,
        title: schema.reports.title,
        kind: schema.reports.kind,
        releasedVersion: schema.reports.releasedVersion,
        releasedAt: schema.reports.releasedAt,
      })
      .from(schema.reports)
      .where(and(eq(schema.reports.projectId, id), eq(schema.reports.customerVisible, true)))
      .orderBy(desc(schema.reports.releasedAt))
      .limit(1);

    const pendingApprovalRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          or(
            and(
              eq(schema.approvals.entityType, 'change_order'),
              inArray(
                schema.approvals.entityId,
                tx
                  .select({ id: schema.changeOrders.id })
                  .from(schema.changeOrders)
                  .where(eq(schema.changeOrders.projectId, id)),
              ),
            ),
            and(
              eq(schema.approvals.entityType, 'budget_version'),
              inArray(
                schema.approvals.entityId,
                tx
                  .select({ id: schema.budgetVersions.id })
                  .from(schema.budgetVersions)
                  .where(eq(schema.budgetVersions.projectId, id)),
              ),
            ),
          ),
        ),
      );

    const team = await loadTeam(tx, access.project, access.assignments);

    let forecastSource: ProjectOverviewDto['schedule']['forecastSource'] = 'unknown';
    if (p.forecastCompletionDate) {
      forecastSource =
        baseline && baseline.computedFinish === p.forecastCompletionDate
          ? 'schedule_baseline'
          : 'change_order_shift';
    }

    return {
      project: toProjectDto(p),
      budget: {
        approvedVersionId: approved?.id ?? null,
        approvedVersion: approved?.version ?? null,
        approvedAt: iso(approved?.approvedAt),
        variance: budgetVarianceToJson(variance) as BudgetVarianceDto,
      },
      schedule: {
        currentScheduleVersion: p.currentScheduleVersion,
        targetCompletionDate: p.targetCompletionDate,
        forecastCompletionDate: p.forecastCompletionDate,
        forecastSource,
        latestBaseline: baseline
          ? {
              version: baseline.version,
              computedFinish: baseline.computedFinish,
              criticalPath: baseline.criticalPath ?? [],
              createdAt: baseline.createdAt.toISOString(),
            }
          : null,
        taskCount: tasks.length,
        percentComplete: overallPercentComplete(tasks),
      },
      milestones: {
        total: milestoneSummary.total,
        byStatus: milestoneSummary.byStatus,
        nextPlannedDate: milestoneSummary.nextPlannedDate,
      },
      defects: {
        open: openDefects,
        bySeverity: bySeverity as ProjectOverviewDto['defects']['bySeverity'],
      },
      changeOrders: { pending: countWhere(pendingStatuses), approved: countWhere(['approved']) },
      latestReleasedReport:
        latestReport && latestReport.releasedVersion !== null
          ? {
              id: latestReport.id,
              title: latestReport.title,
              kind: latestReport.kind,
              releasedVersion: latestReport.releasedVersion,
              releasedAt: iso(latestReport.releasedAt),
            }
          : null,
      pendingApprovals: Number(pendingApprovalRows[0]?.n ?? 0),
      team,
      generatedAt: new Date().toISOString(),
    };
  });
}

async function loadTeam(
  tx: Transaction,
  project: ProjectRow,
  assignments: Array<typeof schema.assignments.$inferSelect>,
): Promise<TeamMemberDto[]> {
  const userIds = new Set<string>(assignments.map((a) => a.assigneeUserId));
  if (project.pmUserId) userIds.add(project.pmUserId);
  if (project.customerContactUserId) userIds.add(project.customerContactUserId);
  const names = new Map<string, string>();
  if (userIds.size > 0) {
    const rows = await tx
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(inArray(schema.user.id, [...userIds]));
    for (const r of rows) names.set(r.id, r.name);
  }
  const team: TeamMemberDto[] = [];
  if (project.pmUserId) {
    team.push({
      userId: project.pmUserId,
      name: names.get(project.pmUserId) ?? null,
      role: 'project_manager',
      status: 'active',
      source: 'project_manager',
    });
  }
  for (const a of assignments.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
    team.push({
      userId: a.assigneeUserId,
      name: names.get(a.assigneeUserId) ?? null,
      role: a.role,
      status: a.status,
      source: 'assignment',
    });
  }
  if (project.customerContactUserId) {
    team.push({
      userId: project.customerContactUserId,
      name: names.get(project.customerContactUserId) ?? null,
      role: 'customer_contact',
      status: 'active',
      source: 'customer_contact',
    });
  }
  return team;
}

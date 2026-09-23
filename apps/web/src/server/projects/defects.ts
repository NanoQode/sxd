import 'server-only';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type DefectCreate,
  type DefectDto,
  type DefectListQuery,
  type DefectTransition,
  type DefectUpdate,
  type EvidenceDto,
  type Page,
  type UnresolvedIssuesDto,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { UNRESOLVED_DEFECT_STATES, defectMachine } from '@simplexd/domain/projects';
import { evaluateTransition, type ActorKind } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, isCustomerOf, requireProject, type AccessCheck, type ProjectAccess } from './access';
import { toEvidenceDto } from './evidence';
import { assertUpdatedAt, ctxFor, decodeCursor, invalidTransition, iso, notFound, pageSlice, userIdOf, type ServiceOptions } from './shared';

type DefectRow = typeof schema.defects.$inferSelect;

const WRITE_CHECKS: AccessCheck[] = [{ staff: 'projects.manage' }, { staff: 'site_visits.perform' }, { partner: 'partner.reports.draft' }];

export function toDefectDto(d: DefectRow): DefectDto {
  return {
    id: d.id,
    organizationId: d.organizationId,
    projectId: d.projectId,
    propertyId: d.propertyId,
    siteVisitId: d.siteVisitId,
    reportId: d.reportId,
    number: d.number,
    title: d.title,
    description: d.description,
    severity: d.severity,
    status: d.status,
    accountableParty: d.accountableParty,
    locationNote: d.locationNote,
    dueDate: d.dueDate,
    resolvedAt: iso(d.resolvedAt),
    verifiedBy: d.verifiedBy,
    verifiedAt: iso(d.verifiedAt),
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function loadDefect(tx: Transaction, identity: RequestIdentity, id: string, checks: AccessCheck[], overrides?: { createdBy?: string | null }) {
  const [d] = await tx.select().from(schema.defects).where(eq(schema.defects.id, id));
  if (!d || !d.projectId) throw notFound('defect');
  const access = await requireProject(tx, identity, d.projectId, checks, overrides);
  return { d, access };
}

export async function createDefect(
  identity: RequestIdentity,
  projectId: string,
  input: DefectCreate,
  options: ServiceOptions = {},
): Promise<DefectDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, WRITE_CHECKS);
    // Numbering per project inside the transaction; the row lock on the max keeps numbers unique.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'defects:' + projectId}))`);
    const [numRow] = await tx
      .select({ max: sql<number>`coalesce(max(${schema.defects.number}), 0)::int` })
      .from(schema.defects)
      .where(eq(schema.defects.projectId, projectId));
    const [row] = await tx
      .insert(schema.defects)
      .values({
        organizationId: access.project.organizationId,
        projectId,
        propertyId: input.propertyId ?? access.project.propertyId,
        siteVisitId: input.siteVisitId ?? null,
        reportId: input.reportId ?? null,
        number: Number(numRow?.max ?? 0) + 1,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity,
        accountableParty: input.accountableParty,
        locationNote: input.locationNote ?? null,
        dueDate: input.dueDate ?? null,
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'defect.created',
      entityType: 'defect',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { projectId, number: row!.number, severity: input.severity, accountableParty: input.accountableParty },
      correlationId: options.correlationId,
    });
    await emit(tx, identity, access, row!, 'created', options);
    return toDefectDto(row!);
  });
}

async function emit(tx: Transaction, identity: RequestIdentity, access: ProjectAccess, d: DefectRow, change: string, options: ServiceOptions) {
  await appendOutbox(tx, {
    eventType: 'project.defect.updated',
    aggregateType: 'defect',
    aggregateId: d.id,
    organizationId: access.project.organizationId,
    actorUserId: identity.session?.user.id ?? null,
    payload: { projectId: d.projectId, defectId: d.id, change, status: d.status, severity: d.severity, pmUserId: access.project.pmUserId, customerContactUserId: access.project.customerContactUserId },
    correlationId: options.correlationId ?? null,
  });
}

export async function getDefect(identity: RequestIdentity, id: string): Promise<DefectDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { d } = await loadDefect(tx, identity, id, PROJECT_READ_CHECKS);
    return toDefectDto(d);
  });
}

export async function listDefects(identity: RequestIdentity, projectId: string, query: DefectListQuery): Promise<Page<DefectDto>> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.defects)
      .where(
        and(
          eq(schema.defects.projectId, projectId),
          query.status ? eq(schema.defects.status, query.status) : undefined,
          query.severity ? eq(schema.defects.severity, query.severity) : undefined,
          query.unresolvedOnly ? inArray(schema.defects.status, [...UNRESOLVED_DEFECT_STATES]) : undefined,
          cursor ? or(lt(schema.defects.createdAt, cursor.createdAt), and(eq(schema.defects.createdAt, cursor.createdAt), lt(schema.defects.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(schema.defects.createdAt), desc(schema.defects.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    return { items: page.items.map(toDefectDto), nextCursor: page.nextCursor };
  });
}

export async function updateDefect(identity: RequestIdentity, id: string, input: DefectUpdate, options: ServiceOptions = {}): Promise<DefectDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { d, access } = await loadDefect(tx, identity, id, WRITE_CHECKS);
    assertUpdatedAt(d.updatedAt, input.expectedUpdatedAt);
    if (d.status === 'closed') throw invalidTransition('closed defects are read-only');
    const { expectedUpdatedAt: _e, ...fields } = input;
    const patch: Partial<typeof schema.defects.$inferInsert> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    const [updated] = await tx.update(schema.defects).set(patch).where(eq(schema.defects.id, id)).returning();
    await recordAudit(tx, identity, {
      action: 'defect.updated',
      entityType: 'defect',
      entityId: id,
      organizationId: access.project.organizationId,
      before: Object.fromEntries(Object.keys(fields).map((k) => [k, (d as Record<string, unknown>)[k] ?? null])),
      after: fields,
      correlationId: options.correlationId,
    });
    await emit(tx, identity, access, updated!, 'updated', options);
    return toDefectDto(updated!);
  });
}

/** Who moved the defect to resolved, from the append-only audit trail. */
async function findResolver(tx: Transaction, defectId: string): Promise<string | null> {
  const [row] = await tx
    .select({ actorUserId: schema.auditEvents.actorUserId })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.entityType, 'defect'), eq(schema.auditEvents.entityId, defectId), eq(schema.auditEvents.action, 'defect.resolved')))
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(1);
  return row?.actorUserId ?? null;
}

export async function transitionDefect(identity: RequestIdentity, id: string, input: DefectTransition, options: ServiceOptions = {}): Promise<DefectDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [existing] = await tx.select().from(schema.defects).where(eq(schema.defects.id, id));
    if (!existing || !existing.projectId) throw notFound('defect');
    const staff = identity.actor.staffRoles.length > 0;
    let checks: AccessCheck[];
    let actor: ActorKind;
    if (input.to === 'verified') {
      checks = [{ staff: 'reports.review' }, { staff: 'projects.manage' }];
      actor = 'staff';
    } else if (staff) {
      checks = [{ staff: 'projects.manage' }, { staff: 'site_visits.perform' }];
      actor = 'staff';
    } else if (identity.actor.isPartner && identity.actor.memberships.length === 0) {
      checks = [{ partner: 'partner.reports.draft' }];
      actor = 'partner';
    } else {
      checks = [{ org: 'org.comment' }];
      actor = 'customer';
    }
    const { d, access } = await loadDefect(tx, identity, id, checks);
    const decision = evaluateTransition(defectMachine, { from: d.status, to: input.to, actor, reason: input.reason ?? null });
    if (!decision.ok) throw invalidTransition(decision.message, { code: decision.code, from: d.status, to: input.to });
    if (input.to === 'verified') {
      const resolver = await findResolver(tx, id);
      if (resolver && resolver === actorId) throw new ApiError('forbidden', 'the person who resolved a defect cannot verify it');
    }
    const patch: Partial<typeof schema.defects.$inferInsert> = { status: input.to };
    if (input.to === 'resolved') patch.resolvedAt = new Date();
    if (input.to === 'verified') {
      patch.verifiedBy = actorId;
      patch.verifiedAt = new Date();
    }
    if (input.to === 'in_progress' && d.status !== 'open' && d.status !== 'acknowledged') {
      patch.resolvedAt = null;
      patch.verifiedBy = null;
      patch.verifiedAt = null;
    }
    const [updated] = await tx
      .update(schema.defects)
      .set(patch)
      .where(and(eq(schema.defects.id, id), eq(schema.defects.status, d.status)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the defect changed while you were deciding; reload');
    await recordAudit(tx, identity, {
      action: `defect.${input.to}`,
      entityType: 'defect',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: d.status },
      after: { status: input.to },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    await emit(tx, identity, access, updated, input.to, options);
    return toDefectDto(updated);
  });
}

export async function listDefectEvidence(identity: RequestIdentity, id: string): Promise<{ items: EvidenceDto[] }> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { access } = await loadDefect(tx, identity, id, PROJECT_READ_CHECKS);
    const customer = isCustomerOf(identity, access);
    const rows = await tx
      .select({ e: schema.evidence, f: schema.fileObjects })
      .from(schema.evidence)
      .leftJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.evidence.fileId))
      .where(
        and(
          eq(schema.evidence.defectId, id),
          customer ? or(inArray(schema.evidence.publication, ['approved', 'redacted_public']), eq(schema.evidence.uploaderUserId, actorId)) : undefined,
        ),
      )
      .orderBy(desc(schema.evidence.createdAt));
    return { items: rows.map((r) => toEvidenceDto(r.e, r.f)) };
  });
}

/** Unresolved defects plus open decisions for the project. */
export async function getUnresolvedIssues(identity: RequestIdentity, projectId: string): Promise<UnresolvedIssuesDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const defects = await tx
      .select()
      .from(schema.defects)
      .where(and(eq(schema.defects.projectId, projectId), inArray(schema.defects.status, [...UNRESOLVED_DEFECT_STATES])))
      .orderBy(desc(schema.defects.severity), desc(schema.defects.createdAt));
    const counts: Record<string, number> = {};
    for (const d of defects) counts[d.status] = (counts[d.status] ?? 0) + 1;
    const [co] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.changeOrders)
      .where(and(eq(schema.changeOrders.projectId, projectId), inArray(schema.changeOrders.status, ['submitted', 'staff_review', 'customer_review'])));
    const [ms] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.projectId, projectId), eq(schema.milestones.status, 'rejected')));
    const [ap] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          or(
            and(eq(schema.approvals.entityType, 'change_order'), inArray(schema.approvals.entityId, tx.select({ id: schema.changeOrders.id }).from(schema.changeOrders).where(eq(schema.changeOrders.projectId, projectId)))),
            and(eq(schema.approvals.entityType, 'budget_version'), inArray(schema.approvals.entityId, tx.select({ id: schema.budgetVersions.id }).from(schema.budgetVersions).where(eq(schema.budgetVersions.projectId, projectId)))),
          ),
        ),
      );
    return {
      projectId,
      defects: defects.map(toDefectDto),
      counts: counts as UnresolvedIssuesDto['counts'],
      pendingChangeOrders: Number(co?.n ?? 0),
      pendingApprovals: Number(ap?.n ?? 0),
      rejectedMilestones: Number(ms?.n ?? 0),
      generatedAt: new Date().toISOString(),
    };
  });
}

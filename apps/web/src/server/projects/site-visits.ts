import 'server-only';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type SiteVisitDto,
  type SiteVisitSchedule,
  type SiteVisitStart,
  type SiteVisitSubmit,
  type SiteVisitSync,
  type SiteVisitSyncItem,
  type SiteVisitSyncResult,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { AuthorizationError, authorizePartner, authorizeStaff } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  PROJECT_READ_CHECKS,
  loadProjectAccess,
  requireProject,
  type ProjectAccess,
} from './access';
import { linkEvidenceInTx } from './evidence';
import {
  ctxFor,
  decodeCursor,
  invalidTransition,
  iso,
  notFound,
  pageSlice,
  userIdOf,
  type ServiceOptions,
} from './shared';

type VisitRow = typeof schema.siteVisits.$inferSelect;

async function evidenceCount(tx: Transaction, visitId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.evidence)
    .where(eq(schema.evidence.siteVisitId, visitId));
  return Number(row?.n ?? 0);
}

async function toDto(tx: Transaction, v: VisitRow): Promise<SiteVisitDto> {
  const inspector = v.inspectorUserId
    ? (
        await tx
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, v.inspectorUserId))
      )[0]
    : undefined;
  return {
    id: v.id,
    organizationId: v.organizationId,
    projectId: v.projectId,
    propertyId: v.propertyId,
    serviceRequestId: v.serviceRequestId,
    appointmentId: v.appointmentId,
    scheduledAt: iso(v.scheduledAt),
    inspectorUserId: v.inspectorUserId,
    inspectorName: inspector?.name ?? null,
    status: v.status,
    instructions: v.instructions,
    checklist: v.checklist ?? null,
    findingsMarkdown: v.findingsMarkdown,
    weather: v.weather,
    accessNote: v.accessNote,
    startedAt: iso(v.startedAt),
    submittedAt: iso(v.submittedAt),
    reviewedBy: v.reviewedBy,
    reviewedAt: iso(v.reviewedAt),
    offlineClientId: v.offlineClientId,
    evidenceCount: await evidenceCount(tx, v.id),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** The inspector named on the visit may perform it: staff `site_visits.perform` or a partner inspector. */
function assertAssignedInspector(
  identity: RequestIdentity,
  access: ProjectAccess,
  v: VisitRow,
): void {
  const actorId = userIdOf(identity);
  if (v.inspectorUserId !== actorId) {
    throw new ApiError('forbidden', 'only the inspector assigned to this visit can perform it');
  }
  const ref = {
    type: 'site_visit',
    id: v.id,
    organizationId: access.project.organizationId,
    assigneeUserIds: [actorId],
    createdBy: actorId,
  };
  if (identity.actor.staffRoles.length > 0) {
    const d = authorizeStaff(identity.actor, 'site_visits.perform', ref);
    if (!d.allowed) throw new AuthorizationError(d);
    return;
  }
  const d = authorizePartner(identity.actor, 'partner.assignments.view', ref);
  if (!d.allowed) throw new AuthorizationError(d);
}

async function assertInspectorUser(tx: Transaction, inspectorUserId: string): Promise<void> {
  const [u] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, inspectorUserId));
  if (!u) throw new ApiError('validation_failed', 'inspectorUserId does not exist');
  const roles = await tx
    .select({ id: schema.staffRoles.id })
    .from(schema.staffRoles)
    .where(and(eq(schema.staffRoles.userId, inspectorUserId), isNull(schema.staffRoles.revokedAt)));
  const partner = await tx
    .select({ id: schema.partnerProfiles.id })
    .from(schema.partnerProfiles)
    .where(eq(schema.partnerProfiles.userId, inspectorUserId));
  if (roles.length === 0 && partner.length === 0) {
    throw new ApiError('validation_failed', 'inspectorUserId must be a staff member or a partner');
  }
}

async function findByOfflineId(
  tx: Transaction,
  offlineClientId: string,
): Promise<VisitRow | undefined> {
  const [row] = await tx
    .select()
    .from(schema.siteVisits)
    .where(eq(schema.siteVisits.offlineClientId, offlineClientId));
  return row;
}

/** Staff schedule a visit for a named inspector (`projects.manage`). */
export async function scheduleSiteVisit(
  identity: RequestIdentity,
  projectId: string,
  input: SiteVisitSchedule,
  options: ServiceOptions = {},
): Promise<SiteVisitDto & { idempotentReplay: boolean }> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    if (input.offlineClientId) {
      const existing = await findByOfflineId(tx, input.offlineClientId);
      if (existing) {
        if (existing.projectId !== projectId)
          throw new ApiError('conflict', 'this offline id was already used elsewhere');
        return { ...(await toDto(tx, existing)), idempotentReplay: true };
      }
    }
    await assertInspectorUser(tx, input.inspectorUserId);
    const [row] = await tx
      .insert(schema.siteVisits)
      .values({
        organizationId: access.project.organizationId,
        projectId,
        propertyId: input.propertyId ?? access.project.propertyId,
        serviceRequestId: input.serviceRequestId ?? access.project.serviceRequestId,
        scheduledAt: new Date(input.scheduledAt),
        inspectorUserId: input.inspectorUserId,
        status: 'scheduled',
        instructions: input.instructions ?? null,
        checklist: input.checklist ?? null,
        offlineClientId: input.offlineClientId ?? null,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'site_visit.scheduled',
      entityType: 'site_visit',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { projectId, inspectorUserId: input.inspectorUserId, scheduledAt: input.scheduledAt },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.site_visit.scheduled',
      aggregateType: 'site_visit',
      aggregateId: row!.id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId,
        siteVisitId: row!.id,
        inspectorUserId: input.inspectorUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return { ...(await toDto(tx, row!)), idempotentReplay: false };
  });
}

async function loadVisit(tx: Transaction, identity: RequestIdentity, id: string) {
  const [v] = await tx.select().from(schema.siteVisits).where(eq(schema.siteVisits.id, id));
  if (!v || !v.projectId) throw notFound('site visit');
  const access = await loadProjectAccess(tx, v.projectId);
  if (!access) throw notFound('site visit');
  return { v, access };
}

export async function getSiteVisit(identity: RequestIdentity, id: string): Promise<SiteVisitDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { v, access } = await loadVisit(tx, identity, id);
    if (v.inspectorUserId !== identity.session?.user.id) {
      await requireProject(tx, identity, access.project.id, PROJECT_READ_CHECKS);
    }
    return toDto(tx, v);
  });
}

export async function listSiteVisits(
  identity: RequestIdentity,
  projectId: string,
  query: { cursor?: string; limit: number; status?: VisitRow['status'] },
): Promise<Page<SiteVisitDto>> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.siteVisits)
      .where(
        and(
          eq(schema.siteVisits.projectId, projectId),
          query.status ? eq(schema.siteVisits.status, query.status) : undefined,
          cursor
            ? or(
                lt(schema.siteVisits.createdAt, cursor.createdAt),
                and(
                  eq(schema.siteVisits.createdAt, cursor.createdAt),
                  lt(schema.siteVisits.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.siteVisits.createdAt), desc(schema.siteVisits.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows, query.limit);
    const items: SiteVisitDto[] = [];
    for (const r of page.items) items.push(await toDto(tx, r));
    return { items, nextCursor: page.nextCursor };
  });
}

export async function startSiteVisit(
  identity: RequestIdentity,
  id: string,
  input: SiteVisitStart,
  options: ServiceOptions = {},
): Promise<SiteVisitDto & { idempotentReplay: boolean }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVisit(tx, identity, id);
    assertAssignedInspector(identity, access, v);
    if (v.status === 'in_progress') return { ...(await toDto(tx, v)), idempotentReplay: true };
    if (v.status !== 'scheduled')
      throw invalidTransition(`visit is ${v.status} and cannot be started`);
    const [updated] = await tx
      .update(schema.siteVisits)
      .set({
        status: 'in_progress',
        startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
      })
      .where(and(eq(schema.siteVisits.id, id), eq(schema.siteVisits.status, 'scheduled')))
      .returning();
    if (!updated) throw invalidTransition('the visit changed while starting; reload');
    await recordAudit(tx, identity, {
      action: 'site_visit.started',
      entityType: 'site_visit',
      entityId: id,
      organizationId: access.project.organizationId,
      after: { startedAt: updated.startedAt?.toISOString() ?? null },
      correlationId: options.correlationId,
    });
    return { ...(await toDto(tx, updated)), idempotentReplay: false };
  });
}

interface SubmitOutcome {
  row: VisitRow;
  idempotentReplay: boolean;
  evidence: SiteVisitSyncResult['evidence'];
}

async function submitInTx(
  tx: Transaction,
  identity: RequestIdentity,
  v: VisitRow,
  access: ProjectAccess,
  input: SiteVisitSubmit,
  options: ServiceOptions,
): Promise<SubmitOutcome> {
  const actorId = userIdOf(identity);
  assertAssignedInspector(identity, access, v);
  if (input.offlineClientId) {
    const existing = await findByOfflineId(tx, input.offlineClientId);
    if (existing) {
      if (existing.inspectorUserId !== actorId)
        throw new ApiError('conflict', 'this offline id was already used by another user');
      if (existing.id !== v.id)
        throw new ApiError('conflict', 'this offline id belongs to a different visit');
      if (existing.status === 'submitted' || existing.status === 'reviewed') {
        return {
          row: existing,
          idempotentReplay: true,
          evidence: await linkAll(tx, identity, access, existing, input, options),
        };
      }
    }
  }
  if (v.status === 'submitted' || v.status === 'reviewed') {
    // No offline id: a repeated submission of an already submitted visit is not an error either.
    return {
      row: v,
      idempotentReplay: true,
      evidence: await linkAll(tx, identity, access, v, input, options),
    };
  }
  if (v.status !== 'scheduled' && v.status !== 'in_progress')
    throw invalidTransition(`visit is ${v.status} and cannot be submitted`);
  const submittedAt = input.submittedAt ? new Date(input.submittedAt) : new Date();
  const [updated] = await tx
    .update(schema.siteVisits)
    .set({
      status: 'submitted',
      findingsMarkdown: input.findingsMarkdown,
      checklist: input.checklist ?? v.checklist,
      weather: input.weather ?? v.weather,
      accessNote: input.accessNote ?? v.accessNote,
      startedAt: v.startedAt ?? submittedAt,
      submittedAt,
      offlineClientId: input.offlineClientId ?? v.offlineClientId,
    })
    .where(and(eq(schema.siteVisits.id, v.id), eq(schema.siteVisits.status, v.status)))
    .returning();
  if (!updated) throw invalidTransition('the visit changed while submitting; reload');
  const evidence = await linkAll(tx, identity, access, updated, input, options);
  await recordAudit(tx, identity, {
    action: 'site_visit.submitted',
    entityType: 'site_visit',
    entityId: v.id,
    organizationId: access.project.organizationId,
    after: {
      submittedAt: submittedAt.toISOString(),
      offlineClientId: input.offlineClientId ?? null,
      evidenceLinked: evidence.length,
    },
    correlationId: options.correlationId,
  });
  await appendOutbox(tx, {
    eventType: 'project.site_visit.submitted',
    aggregateType: 'site_visit',
    aggregateId: v.id,
    organizationId: access.project.organizationId,
    actorUserId: actorId,
    payload: {
      projectId: access.project.id,
      siteVisitId: v.id,
      inspectorUserId: actorId,
      pmUserId: access.project.pmUserId,
    },
    correlationId: options.correlationId ?? null,
  });
  return { row: updated, idempotentReplay: false, evidence };
}

/** Links each file as evidence of the visit; per-file failures are reported, not fatal. */
async function linkAll(
  tx: Transaction,
  identity: RequestIdentity,
  access: ProjectAccess,
  v: VisitRow,
  input: Pick<SiteVisitSubmit, 'evidenceFileIds' | 'offlineClientId'>,
  options: ServiceOptions,
): Promise<SiteVisitSyncResult['evidence']> {
  const out: SiteVisitSyncResult['evidence'] = [];
  for (const fileId of input.evidenceFileIds) {
    const savepoint = `ev_${fileId.replace(/-/g, '')}`;
    await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
    try {
      const r = await linkEvidenceInTx(
        tx,
        identity,
        access,
        {
          fileId,
          siteVisitId: v.id,
          offlineClientId: `${input.offlineClientId ?? v.id}:${fileId}`.slice(0, 128),
        },
        options,
      );
      await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      out.push({
        fileId,
        outcome: r.idempotentReplay ? 'replayed' : 'created',
        evidenceId: r.row.id,
        reason: null,
      });
    } catch (err) {
      await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
      out.push({
        fileId,
        outcome: 'rejected',
        evidenceId: null,
        reason: err instanceof Error ? err.message : 'evidence link failed',
      });
    }
  }
  return out;
}

export async function submitSiteVisit(
  identity: RequestIdentity,
  id: string,
  input: SiteVisitSubmit,
  options: ServiceOptions = {},
): Promise<
  SiteVisitDto & { idempotentReplay: boolean; evidence: SiteVisitSyncResult['evidence'] }
> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVisit(tx, identity, id);
    const outcome = await submitInTx(tx, identity, v, access, input, options);
    return {
      ...(await toDto(tx, outcome.row)),
      idempotentReplay: outcome.idempotentReplay,
      evidence: outcome.evidence,
    };
  });
}

/** Staff review (`reports.review`; never the inspector who performed it). */
export async function reviewSiteVisit(
  identity: RequestIdentity,
  id: string,
  input: { note?: string },
  options: ServiceOptions = {},
): Promise<SiteVisitDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVisit(tx, identity, id);
    await requireProject(tx, identity, access.project.id, [{ staff: 'reports.review' }], {
      createdBy: v.inspectorUserId,
    });
    if (v.inspectorUserId === actorId)
      throw new ApiError('forbidden', 'an inspector cannot review their own visit');
    if (v.status !== 'submitted')
      throw invalidTransition(`visit is ${v.status}; only submitted visits can be reviewed`);
    const [updated] = await tx
      .update(schema.siteVisits)
      .set({ status: 'reviewed', reviewedBy: actorId, reviewedAt: new Date() })
      .where(and(eq(schema.siteVisits.id, id), eq(schema.siteVisits.status, 'submitted')))
      .returning();
    if (!updated) throw invalidTransition('the visit changed while reviewing; reload');
    await recordAudit(tx, identity, {
      action: 'site_visit.reviewed',
      entityType: 'site_visit',
      entityId: id,
      organizationId: access.project.organizationId,
      after: { reviewedBy: actorId },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    return toDto(tx, updated);
  });
}

export async function cancelSiteVisit(
  identity: RequestIdentity,
  id: string,
  input: { reason: string },
  options: ServiceOptions = {},
): Promise<SiteVisitDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { v, access } = await loadVisit(tx, identity, id);
    await requireProject(tx, identity, access.project.id, [{ staff: 'projects.manage' }]);
    if (v.status === 'submitted' || v.status === 'reviewed' || v.status === 'cancelled') {
      throw invalidTransition(`visit is ${v.status} and cannot be cancelled`);
    }
    const [updated] = await tx
      .update(schema.siteVisits)
      .set({ status: 'cancelled', accessNote: v.accessNote })
      .where(eq(schema.siteVisits.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'site_visit.cancelled',
      entityType: 'site_visit',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { status: v.status },
      after: { status: 'cancelled' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.site_visit.cancelled',
      aggregateType: 'site_visit',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: {
        projectId: access.project.id,
        siteVisitId: id,
        inspectorUserId: v.inspectorUserId,
        customerContactUserId: access.project.customerContactUserId,
      },
      correlationId: options.correlationId ?? null,
    });
    return toDto(tx, updated!);
  });
}

/**
 * Offline resume (acceptance scenario 10): each item runs in its own
 * transaction; a repeated offline id replays the stored result instead of
 * duplicating, another user's id is refused, and failures are reported per item.
 */
export async function syncSiteVisits(
  identity: RequestIdentity,
  input: SiteVisitSync,
  options: ServiceOptions = {},
): Promise<{ results: SiteVisitSyncResult[] }> {
  const actorId = userIdOf(identity);
  const results: SiteVisitSyncResult[] = [];
  for (const item of input.items) {
    try {
      results.push(await syncOne(identity, actorId, item, options));
    } catch (err) {
      results.push({
        offlineClientId: item.offlineClientId,
        outcome: 'rejected',
        siteVisitId: item.siteVisitId ?? null,
        code:
          err instanceof ApiError
            ? err.code
            : err instanceof AuthorizationError
              ? 'forbidden'
              : 'internal_error',
        reason: err instanceof Error ? err.message : 'sync failed',
        evidence: [],
      });
    }
  }
  return { results };
}

async function syncOne(
  identity: RequestIdentity,
  actorId: string,
  item: SiteVisitSyncItem,
  options: ServiceOptions,
): Promise<SiteVisitSyncResult> {
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const existing = await findByOfflineId(tx, item.offlineClientId);
    if (existing && existing.inspectorUserId !== actorId) {
      throw new ApiError('conflict', 'this offline id was already used by another user');
    }
    let v: VisitRow;
    let access: ProjectAccess;
    if (existing) {
      v = existing;
      const a = await loadProjectAccess(tx, existing.projectId!);
      if (!a) throw notFound('project');
      access = a;
    } else if (item.siteVisitId) {
      const loaded = await loadVisit(tx, identity, item.siteVisitId);
      v = loaded.v;
      access = loaded.access;
    } else {
      if (!item.projectId)
        throw new ApiError(
          'validation_failed',
          'projectId is required to create a visit from the field',
        );
      access = await requireProject(tx, identity, item.projectId, [
        { staff: 'site_visits.perform' },
      ]);
      const [row] = await tx
        .insert(schema.siteVisits)
        .values({
          organizationId: access.project.organizationId,
          projectId: access.project.id,
          propertyId: access.project.propertyId,
          serviceRequestId: access.project.serviceRequestId,
          scheduledAt: item.scheduledAt
            ? new Date(item.scheduledAt)
            : item.startedAt
              ? new Date(item.startedAt)
              : new Date(),
          inspectorUserId: actorId,
          status: 'in_progress',
          startedAt: item.startedAt ? new Date(item.startedAt) : new Date(),
          offlineClientId: item.offlineClientId,
        })
        .returning();
      v = row!;
      await recordAudit(tx, identity, {
        action: 'site_visit.created_from_field',
        entityType: 'site_visit',
        entityId: v.id,
        organizationId: access.project.organizationId,
        after: { projectId: access.project.id, offlineClientId: item.offlineClientId },
        correlationId: options.correlationId,
      });
    }
    const outcome = await submitInTx(
      tx,
      identity,
      v,
      access,
      {
        findingsMarkdown: item.findingsMarkdown,
        checklist: item.checklist,
        weather: item.weather,
        accessNote: item.accessNote,
        submittedAt: item.submittedAt,
        offlineClientId: item.offlineClientId,
        evidenceFileIds: item.evidenceFileIds,
      },
      options,
    );
    return {
      offlineClientId: item.offlineClientId,
      outcome: outcome.idempotentReplay ? 'replayed' : 'created',
      siteVisitId: outcome.row.id,
      code: null,
      reason: null,
      evidence: outcome.evidence,
    };
  });
}

import 'server-only';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type InvitedTenderDto,
  type Page,
  type TenderCreate,
  type TenderDetail,
  type TenderDraftPatch,
  type TenderDto,
  type TenderInvitationDto,
  type TenderInvitationRespond,
  type TenderInvite,
  type TenderListQuery,
  type TenderRevisionCreate,
  type TenderVariation,
} from '@simplexd/contracts';
import {
  appendOutbox,
  getDb,
  schema,
  withActor,
  type DbExecutor,
  type Transaction,
} from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizeStaff } from '@simplexd/domain/authz';
import {
  closeDecision,
  extensionDecision,
  validateEvaluationWeights,
} from '@simplexd/domain/tenders';
import { nextAddendumRevision, validateTenderTimeline } from '@simplexd/domain/timelines';
import { evaluateTransition, tenderMachine } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { decodeCursor, encodeCursor } from '@/server/portal/elevate';
import { listQuestionsInTx } from './questions';
import {
  allocateCommercialReference,
  assertVersion,
  ctxFor,
  dbNow,
  iso,
  isStaffIdentity,
  loadRevisions,
  loadTenderAccess,
  requireTendering,
  toInvitationDto,
  toRevisionDto,
  toSealedBidSummary,
  toTenderDto,
  type ServiceOptions,
  type TenderRow,
} from './shared';

/**
 * Tender lifecycle: create, edit drafts, publish, revise (append-only
 * addenda and deadline extensions), invite partners, close, cancel and the
 * read models for staff, customers and invited partners.
 */

type TimelineInput = TenderCreate['timeline'];

function timelineColumns(t: TimelineInput) {
  const date = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    releaseAt: date(t.releaseAt),
    siteVisitAt: date(t.siteVisitAt),
    questionCutoffAt: date(t.questionCutoffAt),
    answersPublishedAt: date(t.answersPublishedAt),
    submissionDeadlineAt: date(t.submissionDeadlineAt),
    evaluationCompleteAt: date(t.evaluationCompleteAt),
    awardTargetAt: date(t.awardTargetAt),
  };
}

function assertTimeline(t: TimelineInput): void {
  const result = validateTenderTimeline(t);
  if (!result.ok) {
    throw new ApiError('validation_failed', 'tender timeline is not in order', {
      details: result.violations,
    });
  }
}

function assertWeights(weights: Record<string, number>): void {
  const result = validateEvaluationWeights(weights);
  if (!result.ok) {
    throw new ApiError('validation_failed', 'evaluation weights are invalid', {
      details: result.violations,
    });
  }
}

async function assertOrganizationLinks(
  tx: DbExecutor,
  input: {
    organizationId: string;
    projectId?: string | null;
    scopeFileIds?: string[];
    boqBudgetVersionId?: string | null;
  },
): Promise<void> {
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, input.organizationId));
  if (!org)
    throw new ApiError('validation_failed', 'organisation not found', {
      details: { field: 'organizationId' },
    });
  if (input.projectId) {
    const [project] = await tx
      .select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
      .from(schema.projects)
      .where(eq(schema.projects.id, input.projectId));
    if (!project || project.organizationId !== input.organizationId) {
      throw new ApiError('validation_failed', 'project not found in this organisation', {
        details: { field: 'projectId' },
      });
    }
  }
  if (input.scopeFileIds && input.scopeFileIds.length > 0) {
    const files = await tx
      .select({ id: schema.fileObjects.id })
      .from(schema.fileObjects)
      .where(
        and(
          inArray(schema.fileObjects.id, input.scopeFileIds),
          eq(schema.fileObjects.organizationId, input.organizationId),
        ),
      );
    if (files.length !== new Set(input.scopeFileIds).size) {
      throw new ApiError(
        'validation_failed',
        'every scope file must belong to the tender organisation',
        {
          details: { field: 'scopeFileIds' },
        },
      );
    }
  }
  if (input.boqBudgetVersionId) {
    const [budget] = await tx
      .select({ id: schema.budgetVersions.id, projectId: schema.budgetVersions.projectId })
      .from(schema.budgetVersions)
      .where(eq(schema.budgetVersions.id, input.boqBudgetVersionId));
    if (!budget || (input.projectId && budget.projectId !== input.projectId)) {
      throw new ApiError('validation_failed', 'BOQ budget version not found for this project', {
        details: { field: 'boqBudgetVersionId' },
      });
    }
  }
}

async function invitedPartnerIds(tx: DbExecutor, tenderId: string): Promise<string[]> {
  const rows = await tx
    .select({ partnerUserId: schema.tenderInvitations.partnerUserId })
    .from(schema.tenderInvitations)
    .where(
      and(
        eq(schema.tenderInvitations.tenderId, tenderId),
        sql`${schema.tenderInvitations.status} <> 'declined'`,
      ),
    );
  return rows.map((r) => r.partnerUserId);
}

/* -------------------------------------------------------------------------- */
/* Create and edit                                                            */
/* -------------------------------------------------------------------------- */

export async function createTender(
  identity: RequestIdentity,
  input: TenderCreate,
  options: ServiceOptions = {},
): Promise<TenderDto> {
  const userId = requireTendering(identity);
  assertAllowed(
    authorizeStaff(identity.actor, 'tenders.manage', {
      type: 'tender',
      organizationId: input.organizationId,
    }),
  );
  assertTimeline(input.timeline);
  assertWeights(input.evaluationWeights);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    await assertOrganizationLinks(tx, input);
    const now = await dbNow(tx);
    const reference = await allocateCommercialReference(tx, 'tenders', 'TND', now.date);
    const [row] = await tx
      .insert(schema.tenders)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        serviceRequestId: input.serviceRequestId ?? null,
        reference,
        title: input.title,
        descriptionMarkdown: input.descriptionMarkdown ?? null,
        scopeFileIds: input.scopeFileIds,
        boqBudgetVersionId: input.boqBudgetVersionId ?? null,
        status: 'draft',
        sealed: input.sealed,
        ...timelineColumns(input.timeline),
        displayTimeZone: input.displayTimeZone,
        currentRevision: 1,
        evaluationWeights: input.evaluationWeights,
        partnerDisclosure: input.partnerDisclosure ?? null,
        createdBy: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'tender.created',
      entityType: 'tender',
      entityId: row!.id,
      organizationId: input.organizationId,
      after: {
        reference,
        title: input.title,
        timeline: input.timeline,
        evaluationWeights: input.evaluationWeights,
      },
      correlationId: options.correlationId,
    });
    return toTenderDto(row!, []);
  });
}

export async function updateDraftTender(
  identity: RequestIdentity,
  id: string,
  input: TenderDraftPatch,
  options: ServiceOptions = {},
): Promise<TenderDto> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    if (tender.status !== 'draft') {
      throw new ApiError(
        'invalid_transition',
        'only draft tenders can be edited directly; publish changes as a revision',
        {
          details: { status: tender.status },
        },
      );
    }
    assertVersion(tender.version, input.expectedVersion);
    if (input.timeline) assertTimeline(input.timeline);
    if (input.evaluationWeights) assertWeights(input.evaluationWeights);
    await assertOrganizationLinks(tx, {
      organizationId: tender.organizationId,
      projectId: input.projectId === undefined ? tender.projectId : input.projectId,
      scopeFileIds: input.scopeFileIds,
      boqBudgetVersionId: input.boqBudgetVersionId,
    });
    const patch: Partial<typeof schema.tenders.$inferInsert> = { version: tender.version + 1 };
    if (input.title !== undefined) patch.title = input.title;
    if (input.descriptionMarkdown !== undefined)
      patch.descriptionMarkdown = input.descriptionMarkdown;
    if (input.scopeFileIds !== undefined) patch.scopeFileIds = input.scopeFileIds;
    if (input.boqBudgetVersionId !== undefined) patch.boqBudgetVersionId = input.boqBudgetVersionId;
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.timeline) Object.assign(patch, timelineColumns(input.timeline));
    if (input.displayTimeZone !== undefined) patch.displayTimeZone = input.displayTimeZone;
    if (input.evaluationWeights !== undefined) patch.evaluationWeights = input.evaluationWeights;
    if (input.partnerDisclosure !== undefined) patch.partnerDisclosure = input.partnerDisclosure;
    if (input.sealed !== undefined) patch.sealed = input.sealed;
    const updated = await tx
      .update(schema.tenders)
      .set(patch)
      .where(and(eq(schema.tenders.id, id), eq(schema.tenders.version, tender.version)))
      .returning();
    if (updated.length === 0) throw new ApiError('version_conflict', 'tender changed concurrently');
    await recordAudit(tx, identity, {
      action: 'tender.draft_updated',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      before: { version: tender.version },
      after: { ...input, expectedVersion: undefined, version: tender.version + 1 },
      correlationId: options.correlationId,
    });
    return toTenderDto(updated[0]!, []);
  });
}

/* -------------------------------------------------------------------------- */
/* Publish, revise, close, cancel                                             */
/* -------------------------------------------------------------------------- */

export async function publishTender(
  identity: RequestIdentity,
  id: string,
  input: { expectedVersion: number },
  options: ServiceOptions = {},
): Promise<TenderDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    assertVersion(tender.version, input.expectedVersion);
    const decision = evaluateTransition(tenderMachine, {
      from: tender.status,
      to: 'published',
      actor: 'staff',
    });
    if (!decision.ok)
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code },
      });
    if (!tender.releaseAt || !tender.submissionDeadlineAt) {
      throw new ApiError(
        'validation_failed',
        'release and submission deadline are required before publication',
      );
    }
    assertTimeline({
      releaseAt: tender.releaseAt.toISOString(),
      siteVisitAt: iso(tender.siteVisitAt),
      questionCutoffAt: iso(tender.questionCutoffAt),
      answersPublishedAt: iso(tender.answersPublishedAt),
      submissionDeadlineAt: tender.submissionDeadlineAt.toISOString(),
      evaluationCompleteAt: iso(tender.evaluationCompleteAt),
      awardTargetAt: iso(tender.awardTargetAt),
    });
    const now = await dbNow(tx);
    if (tender.submissionDeadlineAt.getTime() <= now.date.getTime()) {
      throw new ApiError(
        'validation_failed',
        'the submission deadline must be in the future at publication',
        {
          details: {
            submissionDeadlineAt: tender.submissionDeadlineAt.toISOString(),
            serverNow: now.iso,
          },
        },
      );
    }
    const [updated] = await tx
      .update(schema.tenders)
      .set({ status: 'published', version: tender.version + 1 })
      .where(and(eq(schema.tenders.id, id), eq(schema.tenders.version, tender.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'tender changed concurrently');
    const recipients = await invitedPartnerIds(tx, id);
    await appendOutbox(tx, {
      eventType: 'tender.published',
      aggregateType: 'tender',
      aggregateId: id,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: { tenderId: id, recipientUserIds: recipients },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.published',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      before: { status: tender.status },
      after: { status: 'published', invited: recipients.length },
      correlationId: options.correlationId,
    });
    return toTenderDto(updated, await loadRevisions(tx, id));
  });
}

const REVISABLE: ReadonlySet<TenderRow['status']> = new Set(['published', 'clarifications']);

/** Any change after publication is an append-only revision; deadlines only ever move later. */
export async function reviseTender(
  identity: RequestIdentity,
  id: string,
  input: TenderRevisionCreate,
  options: ServiceOptions = {},
): Promise<TenderDetail> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    const { tender } = access;
    if (!REVISABLE.has(tender.status)) {
      throw new ApiError('invalid_transition', 'revisions apply to published tenders only', {
        details: { status: tender.status },
      });
    }
    assertVersion(tender.version, input.expectedVersion);
    const revision = nextAddendumRevision(tender.currentRevision);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const patch: Partial<typeof schema.tenders.$inferInsert> = {
      version: tender.version + 1,
      currentRevision: revision,
    };
    const c = input.changes;
    const setText = <K extends 'title' | 'descriptionMarkdown' | 'partnerDisclosure'>(key: K) => {
      const value = c[key];
      if (value !== undefined && value !== tender[key]) {
        changes[key] = { before: tender[key], after: value };
        patch[key] = value as never;
      }
    };
    setText('title');
    setText('descriptionMarkdown');
    setText('partnerDisclosure');
    if (c.scopeFileIds !== undefined) {
      await assertOrganizationLinks(tx, {
        organizationId: tender.organizationId,
        scopeFileIds: c.scopeFileIds,
      });
      changes['scopeFileIds'] = { before: tender.scopeFileIds ?? [], after: c.scopeFileIds };
      patch.scopeFileIds = c.scopeFileIds;
    }
    const dateKeys = [
      'siteVisitAt',
      'questionCutoffAt',
      'answersPublishedAt',
      'evaluationCompleteAt',
      'awardTargetAt',
    ] as const;
    for (const key of dateKeys) {
      const value = c[key];
      if (value === undefined) continue;
      const before = iso(tender[key]);
      if (before !== value) {
        changes[key] = { before, after: value };
        patch[key] = value ? new Date(value) : null;
      }
    }
    let deadlineExtendedTo: Date | null = null;
    if (input.deadlineExtendedTo) {
      const decision = extensionDecision({
        submissionDeadlineAt: iso(tender.submissionDeadlineAt) ?? '',
        extensions: [],
        extendedTo: input.deadlineExtendedTo,
        addendumRevision: revision,
      });
      if (!decision.ok) {
        throw new ApiError(
          'validation_failed',
          'a deadline can only be extended to a later instant',
          { details: decision.error },
        );
      }
      deadlineExtendedTo = new Date(decision.effectiveDeadlineAt);
      changes['submissionDeadlineAt'] = {
        before: iso(tender.submissionDeadlineAt),
        after: decision.effectiveDeadlineAt,
      };
      patch.submissionDeadlineAt = deadlineExtendedTo;
    }
    const merged = { ...tender, ...patch } as TenderRow;
    assertTimeline({
      releaseAt: iso(merged.releaseAt) ?? '',
      siteVisitAt: iso(merged.siteVisitAt),
      questionCutoffAt: iso(merged.questionCutoffAt),
      answersPublishedAt: iso(merged.answersPublishedAt),
      submissionDeadlineAt: iso(merged.submissionDeadlineAt) ?? '',
      evaluationCompleteAt: iso(merged.evaluationCompleteAt),
      awardTargetAt: iso(merged.awardTargetAt),
    });
    const updated = await tx
      .update(schema.tenders)
      .set(patch)
      .where(and(eq(schema.tenders.id, id), eq(schema.tenders.version, tender.version)))
      .returning();
    if (updated.length === 0) throw new ApiError('version_conflict', 'tender changed concurrently');
    await tx.insert(schema.tenderRevisions).values({
      tenderId: id,
      revision,
      changes,
      addendumMarkdown: input.addendumMarkdown ?? null,
      deadlineExtendedTo,
      reason: input.reason,
      createdBy: userId,
    });
    const recipients = await invitedPartnerIds(tx, id);
    await appendOutbox(tx, {
      eventType: 'tender.revised',
      aggregateType: 'tender',
      aggregateId: id,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: {
        tenderId: id,
        revision,
        deadlineExtended: deadlineExtendedTo !== null,
        recipientUserIds: recipients,
      },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.revised',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before])),
      after: {
        ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after])),
        revision,
      },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return getTenderInTx(tx, identity, id);
  });
}

/** Post-award variation: recorded as an append-only revision with a reason. */
export async function addTenderVariation(
  identity: RequestIdentity,
  id: string,
  input: TenderVariation,
  options: ServiceOptions = {},
): Promise<TenderDetail> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    if (tender.status !== 'awarded') {
      throw new ApiError('invalid_transition', 'variations apply to awarded tenders', {
        details: { status: tender.status },
      });
    }
    const revision = nextAddendumRevision(tender.currentRevision);
    await tx
      .update(schema.tenders)
      .set({ currentRevision: revision, version: tender.version + 1 })
      .where(eq(schema.tenders.id, id));
    await tx.insert(schema.tenderRevisions).values({
      tenderId: id,
      revision,
      changes: { variation: input.changes },
      addendumMarkdown: input.addendumMarkdown ?? null,
      reason: input.reason,
      createdBy: userId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.variation_recorded',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      after: { revision, changes: input.changes },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return getTenderInTx(tx, identity, id);
  });
}

/** Manual close: only once the server clock has passed the effective deadline. */
export async function closeTender(
  identity: RequestIdentity,
  id: string,
  input: { expectedVersion?: number } = {},
  options: ServiceOptions = {},
): Promise<TenderDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    assertVersion(tender.version, input.expectedVersion);
    if (!REVISABLE.has(tender.status)) {
      throw new ApiError('invalid_transition', `cannot close a ${tender.status} tender`, {
        details: { status: tender.status },
      });
    }
    const now = await dbNow(tx);
    const decision = closeDecision({
      now: now.iso,
      submissionDeadlineAt: iso(tender.submissionDeadlineAt) ?? '',
    });
    if (!decision.canClose) {
      throw new ApiError('invalid_transition', 'the submission deadline has not passed yet', {
        details: {
          reason: decision.reason,
          effectiveDeadlineAt: decision.effectiveDeadlineAt,
          serverNow: now.iso,
        },
      });
    }
    const [updated] = await tx
      .update(schema.tenders)
      .set({ status: 'closed', closedAt: now.date, version: tender.version + 1 })
      .where(and(eq(schema.tenders.id, id), eq(schema.tenders.version, tender.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'tender changed concurrently');
    await appendOutbox(tx, {
      eventType: 'tender.closed',
      aggregateType: 'tender',
      aggregateId: id,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: { tenderId: id, closedAt: now.iso },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.closed',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      before: { status: tender.status },
      after: { status: 'closed', closedAt: now.iso },
      correlationId: options.correlationId,
    });
    return toTenderDto(updated, await loadRevisions(tx, id));
  });
}

export async function cancelTender(
  identity: RequestIdentity,
  id: string,
  input: { reason: string; expectedVersion: number },
  options: ServiceOptions = {},
): Promise<TenderDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    assertVersion(tender.version, input.expectedVersion);
    const decision = evaluateTransition(tenderMachine, {
      from: tender.status,
      to: 'cancelled',
      actor: 'staff',
      reason: input.reason,
    });
    if (!decision.ok)
      throw new ApiError('invalid_transition', decision.message, {
        details: { code: decision.code },
      });
    const [updated] = await tx
      .update(schema.tenders)
      .set({ status: 'cancelled', cancelledReason: input.reason, version: tender.version + 1 })
      .where(and(eq(schema.tenders.id, id), eq(schema.tenders.version, tender.version)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'tender changed concurrently');
    const recipients = await invitedPartnerIds(tx, id);
    await appendOutbox(tx, {
      eventType: 'tender.cancelled',
      aggregateType: 'tender',
      aggregateId: id,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: { tenderId: id, recipientUserIds: recipients },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.cancelled',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      before: { status: tender.status },
      after: { status: 'cancelled' },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return toTenderDto(updated, await loadRevisions(tx, id));
  });
}

/* -------------------------------------------------------------------------- */
/* Invitations                                                                */
/* -------------------------------------------------------------------------- */

export async function inviteTenderPartners(
  identity: RequestIdentity,
  id: string,
  input: TenderInvite,
  options: ServiceOptions = {},
): Promise<TenderInvitationDto[]> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { tender } = await loadTenderAccess(tx, identity, id, {
      staff: ['tenders.manage'],
      customer: false,
    });
    if (!['draft', 'published', 'clarifications'].includes(tender.status)) {
      throw new ApiError(
        'invalid_transition',
        'invitations can only be added before the tender closes',
        {
          details: { status: tender.status },
        },
      );
    }
    const ids = [...new Set(input.partnerUserIds)];
    const partners = await tx
      .select({ userId: schema.partnerProfiles.userId })
      .from(schema.partnerProfiles)
      .where(inArray(schema.partnerProfiles.userId, ids));
    const known = new Set(partners.map((p) => p.userId));
    const missing = ids.filter((p) => !known.has(p));
    if (missing.length > 0) {
      throw new ApiError('validation_failed', 'every invitee must have a partner profile', {
        details: { missing },
      });
    }
    const inserted = await tx
      .insert(schema.tenderInvitations)
      .values(ids.map((partnerUserId) => ({ tenderId: id, partnerUserId, invitedBy: userId })))
      .onConflictDoNothing()
      .returning();
    const newIds = inserted.map((i) => i.partnerUserId);
    if (newIds.length > 0 && tender.status !== 'draft') {
      await appendOutbox(tx, {
        eventType: 'tender.invitation.sent',
        aggregateType: 'tender',
        aggregateId: id,
        organizationId: tender.organizationId,
        actorUserId: userId,
        payload: { tenderId: id, recipientUserIds: newIds },
        correlationId: options.correlationId,
      });
    }
    await recordAudit(tx, identity, {
      action: 'tender.partners_invited',
      entityType: 'tender',
      entityId: id,
      organizationId: tender.organizationId,
      after: { invited: newIds, alreadyInvited: ids.filter((p) => !newIds.includes(p)) },
      correlationId: options.correlationId,
    });
    return listInvitationsInTx(tx, id);
  });
}

async function listInvitationsInTx(
  tx: DbExecutor,
  tenderId: string,
): Promise<TenderInvitationDto[]> {
  const rows = await tx
    .select({ inv: schema.tenderInvitations, name: schema.user.name })
    .from(schema.tenderInvitations)
    .leftJoin(schema.user, eq(schema.user.id, schema.tenderInvitations.partnerUserId))
    .where(eq(schema.tenderInvitations.tenderId, tenderId))
    .orderBy(schema.tenderInvitations.invitedAt);
  return rows.map((r) => toInvitationDto(r.inv, r.name));
}

export async function listTenderInvitations(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<TenderInvitationDto[]> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, id);
    if (access.role === 'partner') {
      return [toInvitationDto(access.invitation!, identity.session?.user.name ?? null)];
    }
    return listInvitationsInTx(tx, id);
  });
}

/**
 * Partner response. The invitation enum has no "accepted" value: accepting
 * records `respondedAt` and keeps the invitation open (viewed); declining
 * marks it declined. Submitting a bid later flips the status to submitted.
 */
export async function respondToInvitation(
  identity: RequestIdentity,
  id: string,
  input: TenderInvitationRespond,
  options: ServiceOptions = {},
): Promise<TenderInvitationDto> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, id, { customer: false });
    if (access.role !== 'partner' || !access.invitation)
      throw new ApiError('forbidden', 'only invited partners respond');
    if (access.invitation.status === 'submitted') {
      throw new ApiError(
        'invalid_transition',
        'a bid has already been submitted for this invitation',
      );
    }
    const now = await dbNow(tx);
    const [updated] = await tx
      .update(schema.tenderInvitations)
      .set({
        status: input.decision === 'decline' ? 'declined' : 'viewed',
        respondedAt: now.date,
        viewedAt: access.invitation.viewedAt ?? now.date,
      })
      .where(eq(schema.tenderInvitations.id, access.invitation.id))
      .returning();
    await recordAudit(tx, identity, {
      action: `tender.invitation.${input.decision === 'decline' ? 'declined' : 'accepted'}`,
      entityType: 'tender_invitation',
      entityId: access.invitation.id,
      organizationId: access.tender.organizationId,
      after: { tenderId: id, decision: input.decision, note: input.note ?? null },
      correlationId: options.correlationId,
    });
    return toInvitationDto(updated!, identity.session?.user.name ?? null);
  });
}

/* -------------------------------------------------------------------------- */
/* Read models                                                                */
/* -------------------------------------------------------------------------- */

async function getTenderInTx(
  tx: Transaction,
  identity: RequestIdentity,
  id: string,
): Promise<TenderDetail> {
  const userId = identity.session!.user.id;
  const access = await loadTenderAccess(tx, identity, id);
  const { tender, revisions } = access;
  let invitation = access.invitation;
  if (access.role === 'partner' && invitation && invitation.status === 'invited') {
    const now = await dbNow(tx);
    const [updated] = await tx
      .update(schema.tenderInvitations)
      .set({ status: 'viewed', viewedAt: now.date })
      .where(eq(schema.tenderInvitations.id, invitation.id))
      .returning();
    invitation = updated ?? invitation;
    await recordAudit(tx, identity, {
      action: 'tender.invitation.viewed',
      entityType: 'tender_invitation',
      entityId: invitation.id,
      organizationId: tender.organizationId,
      after: { tenderId: id },
    });
  }
  const dto = toTenderDto(tender, revisions);
  const questions = await listQuestionsInTx(tx, identity, access);
  if (access.role === 'partner') {
    const [bid] = await tx
      .select()
      .from(schema.bids)
      .where(and(eq(schema.bids.tenderId, id), eq(schema.bids.partnerUserId, userId)));
    return {
      ...dto,
      revisions: revisions.map(toRevisionDto),
      invitations: invitation
        ? [toInvitationDto(invitation, identity.session?.user.name ?? null)]
        : [],
      questions,
      myInvitation: invitation
        ? toInvitationDto(invitation, identity.session?.user.name ?? null)
        : null,
      myBid: bid
        ? {
            ...toSealedBidSummary(bid, identity.session?.user.name ?? null),
            sealed: false,
            openedAt: iso(bid.openedAt),
          }
        : null,
      bidCount: null,
    };
  }
  const invitations = await listInvitationsInTx(tx, id);
  const bidCount = invitations.filter((i) => i.status === 'submitted').length;
  return {
    ...dto,
    revisions: revisions.map(toRevisionDto),
    invitations,
    questions,
    myInvitation: null,
    myBid: null,
    bidCount,
  };
}

export async function getTender(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<TenderDetail> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), (tx) => getTenderInTx(tx, identity, id));
}

/** Staff list every tender (filters); customers list their active organisation's tenders. */
export async function listTenders(
  identity: RequestIdentity,
  query: TenderListQuery,
  options: ServiceOptions = {},
): Promise<Page<TenderDto>> {
  requireTendering(identity);
  const cursor = decodeCursor(query.cursor);
  let organizationId = query.organizationId ?? null;
  if (isStaffIdentity(identity)) {
    assertAllowed(authorizeStaff(identity.actor, 'tenders.manage'));
  } else {
    organizationId = identity.ctx.organizationId;
    if (!organizationId) return { items: [], nextCursor: null };
    assertAllowed(authorizeOrg(identity.actor, 'org.read', { type: 'tender', organizationId }));
  }
  const rows = await withActor(getDb(), ctxFor(identity, options), (tx) =>
    tx
      .select()
      .from(schema.tenders)
      .where(
        and(
          organizationId ? eq(schema.tenders.organizationId, organizationId) : undefined,
          query.status ? eq(schema.tenders.status, query.status) : undefined,
          query.projectId ? eq(schema.tenders.projectId, query.projectId) : undefined,
          cursor
            ? or(
                lt(schema.tenders.createdAt, cursor.createdAt),
                and(
                  eq(schema.tenders.createdAt, cursor.createdAt),
                  lt(schema.tenders.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.tenders.createdAt), desc(schema.tenders.id))
      .limit(query.limit + 1),
  );
  const items = rows.slice(0, query.limit).map((r) => toTenderDto(r, []));
  const last = rows.length > query.limit ? rows[query.limit - 1] : null;
  return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
}

/** Partner workspace: tenders the caller was invited to, with their invitation and own bid. */
export async function listMyInvitedTenders(
  identity: RequestIdentity,
  query: { cursor?: string; limit: number; status?: TenderRow['status'] },
  options: ServiceOptions = {},
): Promise<Page<InvitedTenderDto>> {
  const userId = requireTendering(identity);
  if (!identity.actor.isPartner) throw new ApiError('forbidden', 'partner account required');
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const rows = await tx
      .select({ tender: schema.tenders, inv: schema.tenderInvitations })
      .from(schema.tenderInvitations)
      .innerJoin(schema.tenders, eq(schema.tenders.id, schema.tenderInvitations.tenderId))
      .where(
        and(
          eq(schema.tenderInvitations.partnerUserId, userId),
          sql`${schema.tenders.status} <> 'draft'`,
          query.status ? eq(schema.tenders.status, query.status) : undefined,
          cursor
            ? or(
                lt(schema.tenders.createdAt, cursor.createdAt),
                and(
                  eq(schema.tenders.createdAt, cursor.createdAt),
                  lt(schema.tenders.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.tenders.createdAt), desc(schema.tenders.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const bids = page.length
      ? await tx
          .select()
          .from(schema.bids)
          .where(
            and(
              eq(schema.bids.partnerUserId, userId),
              inArray(
                schema.bids.tenderId,
                page.map((r) => r.tender.id),
              ),
            ),
          )
      : [];
    const byTender = new Map(bids.map((b) => [b.tenderId, b]));
    const name = identity.session?.user.name ?? null;
    const items = page.map((r) => {
      const bid = byTender.get(r.tender.id);
      return {
        ...toTenderDto(r.tender, []),
        invitation: toInvitationDto(r.inv, name),
        myBid: bid
          ? { ...toSealedBidSummary(bid, name), sealed: false, openedAt: iso(bid.openedAt) }
          : null,
      };
    });
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.tender.createdAt, last.tender.id) : null };
  });
}

import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  ApiError,
  type DesignCommentCreate,
  type DesignCommentDto,
  type DesignOptionCreate,
  type DesignOptionDto,
  type DesignOptionNewVersion,
  type DesignOptionUpdate,
  type DesignSignOff,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, requireProject, type AccessCheck, type ProjectAccess } from './access';
import { requireLinkableFile } from './evidence';
import { assertUpdatedAt, ctxFor, invalidTransition, iso, notFound, userIdOf, type ServiceOptions } from './shared';

type OptionRow = typeof schema.designOptions.$inferSelect;
type CommentRow = typeof schema.designComments.$inferSelect;

const COMMENT_CHECKS: AccessCheck[] = [{ staff: 'projects.manage' }, { staff: 'reports.draft' }, { org: 'org.comment' }, { partner: 'partner.reports.draft' }];

function statusOf(o: OptionRow): DesignOptionDto['status'] {
  return o.status === 'signed_off' || o.status === 'superseded' ? o.status : 'draft';
}

async function toDto(tx: Transaction, o: OptionRow): Promise<DesignOptionDto> {
  const comments = await tx
    .select({ c: schema.designComments, authorName: schema.user.name })
    .from(schema.designComments)
    .leftJoin(schema.user, eq(schema.user.id, schema.designComments.authorUserId))
    .where(eq(schema.designComments.designOptionId, o.id))
    .orderBy(asc(schema.designComments.createdAt));
  const [latest] = await tx
    .select({ max: sql<number>`max(${schema.designOptions.version})::int` })
    .from(schema.designOptions)
    .where(and(eq(schema.designOptions.projectId, o.projectId), eq(schema.designOptions.title, o.title)));
  return {
    id: o.id,
    projectId: o.projectId,
    title: o.title,
    description: o.description,
    drawingFileIds: o.drawingFileIds ?? [],
    version: o.version,
    status: statusOf(o),
    isCurrentVersion: Number(latest?.max ?? o.version) === o.version,
    customerSignoffBy: o.customerSignoffBy,
    customerSignoffAt: iso(o.customerSignoffAt),
    createdBy: o.createdBy,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    comments: comments.map((r) => toCommentDto(r.c, r.authorName)),
  };
}

function toCommentDto(c: CommentRow, authorName: string | null): DesignCommentDto {
  return {
    id: c.id,
    designOptionId: c.designOptionId,
    authorUserId: c.authorUserId,
    authorName,
    body: c.body,
    anchor: c.anchor ?? null,
    resolvedAt: iso(c.resolvedAt),
    createdAt: c.createdAt.toISOString(),
  };
}

async function loadOption(tx: Transaction, identity: RequestIdentity, id: string, checks: AccessCheck[]) {
  const [o] = await tx.select().from(schema.designOptions).where(eq(schema.designOptions.id, id));
  if (!o) throw notFound('design option');
  const access = await requireProject(tx, identity, o.projectId, checks);
  return { o, access };
}

async function checkDrawings(tx: Transaction, access: ProjectAccess, fileIds: string[], actorId: string): Promise<void> {
  for (const id of fileIds) await requireLinkableFile(tx, access, id, actorId);
}

export async function createDesignOption(identity: RequestIdentity, projectId: string, input: DesignOptionCreate, options: ServiceOptions = {}): Promise<DesignOptionDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, [{ staff: 'projects.manage' }]);
    await checkDrawings(tx, access, input.drawingFileIds, actorId);
    const [dup] = await tx
      .select({ id: schema.designOptions.id })
      .from(schema.designOptions)
      .where(and(eq(schema.designOptions.projectId, projectId), eq(schema.designOptions.title, input.title)));
    if (dup) throw new ApiError('conflict', 'an option with this title exists; add a new version to it instead');
    const [row] = await tx
      .insert(schema.designOptions)
      .values({ projectId, title: input.title, description: input.description ?? null, drawingFileIds: input.drawingFileIds, version: 1, status: 'draft', createdBy: actorId })
      .returning();
    await recordAudit(tx, identity, {
      action: 'design_option.created',
      entityType: 'design_option',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { projectId, title: input.title, drawingFileIds: input.drawingFileIds },
      correlationId: options.correlationId,
    });
    return toDto(tx, row!);
  });
}

export async function listDesignOptions(identity: RequestIdentity, projectId: string): Promise<{ items: DesignOptionDto[] }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const rows = await tx
      .select()
      .from(schema.designOptions)
      .where(eq(schema.designOptions.projectId, projectId))
      .orderBy(asc(schema.designOptions.title), desc(schema.designOptions.version));
    const items: DesignOptionDto[] = [];
    for (const r of rows) items.push(await toDto(tx, r));
    return { items };
  });
}

export async function getDesignOption(identity: RequestIdentity, id: string): Promise<DesignOptionDto> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const { o } = await loadOption(tx, identity, id, PROJECT_READ_CHECKS);
    return toDto(tx, o);
  });
}

function assertMutable(o: OptionRow): void {
  if (o.status === 'signed_off') throw new ApiError('conflict', 'this option version was signed off and is immutable; create a new version');
  if (o.status === 'superseded') throw new ApiError('conflict', 'this option version was superseded; edit the current version');
}

export async function updateDesignOption(identity: RequestIdentity, id: string, input: DesignOptionUpdate, options: ServiceOptions = {}): Promise<DesignOptionDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { o, access } = await loadOption(tx, identity, id, [{ staff: 'projects.manage' }]);
    assertMutable(o);
    assertUpdatedAt(o.updatedAt, input.expectedUpdatedAt);
    if (input.drawingFileIds) await checkDrawings(tx, access, input.drawingFileIds, actorId);
    const [updated] = await tx
      .update(schema.designOptions)
      .set({
        description: input.description !== undefined ? input.description : o.description,
        drawingFileIds: input.drawingFileIds ?? o.drawingFileIds,
      })
      .where(eq(schema.designOptions.id, id))
      .returning();
    await recordAudit(tx, identity, {
      action: 'design_option.updated',
      entityType: 'design_option',
      entityId: id,
      organizationId: access.project.organizationId,
      before: { description: o.description, drawingFileIds: o.drawingFileIds },
      after: { description: updated!.description, drawingFileIds: updated!.drawingFileIds },
      correlationId: options.correlationId,
    });
    return toDto(tx, updated!);
  });
}

export async function addDesignComment(identity: RequestIdentity, optionId: string, input: DesignCommentCreate, options: ServiceOptions = {}): Promise<DesignCommentDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { o, access } = await loadOption(tx, identity, optionId, COMMENT_CHECKS);
    if (o.status === 'superseded') throw new ApiError('conflict', 'comment on the current version of this option');
    const [row] = await tx
      .insert(schema.designComments)
      .values({ designOptionId: optionId, authorUserId: actorId, body: input.body, anchor: input.anchor ?? null })
      .returning();
    await recordAudit(tx, identity, {
      action: 'design_comment.created',
      entityType: 'design_comment',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      after: { designOptionId: optionId, anchored: Boolean(input.anchor) },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.design.commented',
      aggregateType: 'design_option',
      aggregateId: optionId,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: { projectId: o.projectId, designOptionId: optionId, commentId: row!.id, pmUserId: access.project.pmUserId },
      correlationId: options.correlationId ?? null,
    });
    const [u] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, actorId));
    return toCommentDto(row!, u?.name ?? null);
  });
}

export async function resolveDesignComment(identity: RequestIdentity, optionId: string, commentId: string, options: ServiceOptions = {}): Promise<DesignCommentDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { access } = await loadOption(tx, identity, optionId, COMMENT_CHECKS);
    const [c] = await tx.select().from(schema.designComments).where(and(eq(schema.designComments.id, commentId), eq(schema.designComments.designOptionId, optionId)));
    if (!c) throw notFound('comment');
    const staff = identity.actor.staffRoles.length > 0;
    if (!staff && c.authorUserId !== actorId) throw new ApiError('forbidden', 'only staff or the comment author can resolve a comment');
    if (c.resolvedAt) return toCommentDto(c, null);
    const [updated] = await tx.update(schema.designComments).set({ resolvedAt: new Date() }).where(eq(schema.designComments.id, commentId)).returning();
    await recordAudit(tx, identity, {
      action: 'design_comment.resolved',
      entityType: 'design_comment',
      entityId: commentId,
      organizationId: access.project.organizationId,
      correlationId: options.correlationId,
    });
    const [u] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, c.authorUserId));
    return toCommentDto(updated!, u?.name ?? null);
  });
}

/** Customer sign-off on this exact version (`org.change_orders.approve`); immutable afterwards. */
export async function signOffDesignOption(identity: RequestIdentity, id: string, input: DesignSignOff, options: ServiceOptions = {}): Promise<DesignOptionDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { o, access } = await loadOption(tx, identity, id, [{ org: 'org.change_orders.approve' }]);
    if (o.status === 'signed_off') throw new ApiError('conflict', 'this version was already signed off');
    if (o.status === 'superseded') throw invalidTransition('a superseded version cannot be signed off');
    if (!input.confirm) throw new ApiError('validation_failed', 'explicit confirmation is required');
    const [updated] = await tx
      .update(schema.designOptions)
      .set({ status: 'signed_off', customerSignoffBy: actorId, customerSignoffAt: new Date() })
      .where(and(eq(schema.designOptions.id, id), eq(schema.designOptions.status, o.status)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the option changed while signing off; reload');
    await recordAudit(tx, identity, {
      action: 'design_option.signed_off',
      entityType: 'design_option',
      entityId: id,
      organizationId: access.project.organizationId,
      after: { version: o.version, customerSignoffBy: actorId },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.design.signed_off',
      aggregateType: 'design_option',
      aggregateId: id,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: { projectId: o.projectId, designOptionId: id, version: o.version, pmUserId: access.project.pmUserId },
      correlationId: options.correlationId ?? null,
    });
    return toDto(tx, updated);
  });
}

/** A new version supersedes the current one; a signed-off version keeps its sign-off record untouched. */
export async function createDesignOptionVersion(identity: RequestIdentity, id: string, input: DesignOptionNewVersion, options: ServiceOptions = {}): Promise<DesignOptionDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const { o, access } = await loadOption(tx, identity, id, [{ staff: 'projects.manage' }]);
    await checkDrawings(tx, access, input.drawingFileIds, actorId);
    const [latest] = await tx
      .select({ max: sql<number>`max(${schema.designOptions.version})::int` })
      .from(schema.designOptions)
      .where(and(eq(schema.designOptions.projectId, o.projectId), eq(schema.designOptions.title, o.title)));
    const version = Number(latest?.max ?? o.version) + 1;
    if (o.status !== 'signed_off') {
      await tx.update(schema.designOptions).set({ status: 'superseded' }).where(eq(schema.designOptions.id, o.id));
    }
    const [row] = await tx
      .insert(schema.designOptions)
      .values({
        projectId: o.projectId,
        title: o.title,
        description: input.description !== undefined ? input.description : o.description,
        drawingFileIds: input.drawingFileIds,
        version,
        status: 'draft',
        createdBy: actorId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'design_option.new_version',
      entityType: 'design_option',
      entityId: row!.id,
      organizationId: access.project.organizationId,
      before: { previousOptionId: o.id, previousVersion: o.version, previousStatus: o.status },
      after: { version },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    return toDto(tx, row!);
  });
}

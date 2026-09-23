import 'server-only';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type ConversationCreate,
  type ConversationDetail,
  type ConversationDto,
  type ConversationListQuery,
  type ConversationParticipantDto,
  type Page,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizePartner } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ENTITY_STAFF_READ,
  classifyViewer,
  entityResourceRef,
  resolveEntity,
  type CollaborationEntityType,
  type EntityAccess,
} from '@/server/assignments/access';
import {
  actorContext,
  decodeCursor,
  elevate,
  encodeCursor,
  iso,
  isStaffIdentity,
  requireUserId,
  uniqueIds,
  userNameMap,
  type ServiceOptions,
} from '@/server/assignments/shared';
import {
  activeParticipantIds,
  activeStaffAmong,
  existingUsers,
  orgMembers,
  requireConversation,
  type ConversationContext,
  type ConversationRow,
  type ParticipantRow,
} from './access';
import { insertMessage } from './messages';

/**
 * Conversations: threads between a customer organisation, its team, its
 * assigned partners and, for internal kinds, staff only. Access is by
 * participation (plus staff holding messages.read_all as observers). Every
 * participant must already have access to the linked entity or organisation,
 * so a conversation can never widen what someone may see.
 */

async function unreadCount(tx: DbExecutor, ctx: ConversationContext, userId: string): Promise<number> {
  if (!ctx.self) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, ctx.conversation.id),
        ctx.self.lastReadAt ? gt(schema.messages.createdAt, ctx.self.lastReadAt) : undefined,
        or(isNull(schema.messages.senderUserId), ne(schema.messages.senderUserId, userId)),
      ),
    );
  return Number(row?.n ?? 0);
}

function toDto(row: ConversationRow, unread: number): ConversationDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    subject: row.subject,
    entityType: row.entityType,
    entityId: row.entityId,
    createdBy: row.createdBy,
    lastMessageAt: iso(row.lastMessageAt),
    closedAt: iso(row.closedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    unreadCount: unread,
  };
}

function toParticipantDto(p: ParticipantRow, names: Map<string, string>): ConversationParticipantDto {
  return {
    userId: p.userId,
    name: names.get(p.userId) ?? null,
    role: p.role,
    joinedAt: p.joinedAt.toISOString(),
    lastReadAt: iso(p.lastReadAt),
    leftAt: iso(p.leftAt),
  };
}

async function toDetail(tx: DbExecutor, ctx: ConversationContext, userId: string): Promise<ConversationDetail> {
  const names = await userNameMap(
    tx,
    ctx.participants.map((p) => p.userId),
  );
  return {
    ...toDto(ctx.conversation, await unreadCount(tx, ctx, userId)),
    participants: ctx.participants.map((p) => toParticipantDto(p, names)),
  };
}

interface Scope {
  organizationId: string | null;
  entity: EntityAccess | null;
}

/** Proves the creator's access to the linked entity (or organisation) and returns the scope. */
async function resolveScope(
  tx: DbExecutor,
  identity: RequestIdentity,
  input: ConversationCreate,
): Promise<Scope> {
  const staff = isStaffIdentity(identity);
  if (input.entityType && input.entityId) {
    const entity = await resolveEntity(tx, input.entityType as CollaborationEntityType, input.entityId);
    if (!entity) throw new ApiError('not_found', `${input.entityType.replace('_', ' ')} not found`);
    const ref = await entityResourceRef(tx, identity, entity);
    const viewer = classifyViewer(identity, entity, ref, ENTITY_STAFF_READ[entity.type]);
    if (!viewer) throw new ApiError('forbidden', 'you do not have access to this resource');
    if (viewer === 'customer') {
      assertAllowed(authorizeOrg(identity.actor, 'org.messages.send', ref));
    } else if (viewer === 'assignee' && !staff) {
      assertAllowed(authorizePartner(identity.actor, 'partner.assignments.view', ref));
    }
    if (input.organizationId && input.organizationId !== entity.organizationId) {
      throw new ApiError('validation_failed', 'organizationId does not match the linked entity');
    }
    return { organizationId: entity.organizationId, entity };
  }
  if (staff) {
    if (input.kind === 'internal') return { organizationId: input.organizationId ?? null, entity: null };
    if (!input.organizationId) {
      throw new ApiError('validation_failed', 'organizationId is required without a linked entity', {
        details: [{ path: 'organizationId', message: 'required' }],
      });
    }
    return { organizationId: input.organizationId, entity: null };
  }
  const active = identity.ctx.organizationId;
  if (!active) throw new ApiError('forbidden', 'join an organisation before starting a conversation');
  if (input.organizationId && input.organizationId !== active) {
    throw new ApiError('forbidden', 'conversations can only be started in the active organisation');
  }
  assertAllowed(
    authorizeOrg(identity.actor, 'org.messages.send', { type: 'organization', organizationId: active }),
  );
  return { organizationId: active, entity: null };
}

/**
 * Every participant must already have access: organisation members, staff,
 * or partners holding an accepted/active assignment on the linked entity.
 * Internal conversations are staff-only. Runs after elevation so staff roles
 * of other users are visible.
 */
async function validateParticipants(
  tx: DbExecutor,
  scope: Scope,
  kind: ConversationCreate['kind'],
  userIds: string[],
): Promise<void> {
  const users = await existingUsers(tx, userIds);
  const staff = await activeStaffAmong(tx, userIds);
  const members = scope.organizationId ? await orgMembers(tx, scope.organizationId) : new Map<string, string>();
  const assignees = new Set(scope.entity?.assigneeUserIds ?? []);
  const issues: Array<{ path: string; message: string }> = [];
  for (const id of userIds) {
    if (!users.has(id)) {
      issues.push({ path: 'participantUserIds', message: `unknown user ${id}` });
      continue;
    }
    if (kind === 'internal') {
      if (!staff.has(id)) issues.push({ path: 'participantUserIds', message: `${id} is not staff` });
      continue;
    }
    if (staff.has(id) || members.has(id) || assignees.has(id)) continue;
    issues.push({ path: 'participantUserIds', message: `${id} has no access to this conversation's scope` });
  }
  if (issues.length > 0) {
    throw new ApiError('validation_failed', 'some participants may not join this conversation', {
      details: issues,
    });
  }
}

export async function createConversation(
  identity: RequestIdentity,
  input: ConversationCreate,
  options: ServiceOptions = {},
): Promise<ConversationDetail> {
  const userId = requireUserId(identity);
  const staff = isStaffIdentity(identity);
  if (input.kind === 'internal' && !staff) throw new ApiError('forbidden', 'internal conversations are staff only');
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const scope = await resolveScope(tx, identity, input);
    const participantIds = uniqueIds([userId, ...input.participantUserIds]);
    // Elevation is required here: app.can_access_conversation(id) needs a
    // participant row, which cannot exist before the conversation row does,
    // so a non-staff creator cannot insert either under their own context.
    // The creator's access to the entity/organisation was proven above; the
    // participant validation below needs staff roles of other users, which
    // customers cannot read.
    await elevate(tx, ctx);
    await validateParticipants(tx, scope, input.kind, participantIds);
    const [conversation] = await tx
      .insert(schema.conversations)
      .values({
        organizationId: scope.organizationId,
        kind: input.kind,
        subject: input.subject,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        createdBy: userId,
      })
      .returning();
    await tx.insert(schema.conversationParticipants).values(
      participantIds.map((id) => ({
        conversationId: conversation!.id,
        userId: id,
        role: id === userId ? 'owner' : 'participant',
      })),
    );
    await recordAudit(tx, identity, {
      action: 'conversation.created',
      entityType: 'conversation',
      entityId: conversation!.id,
      organizationId: scope.organizationId,
      after: {
        kind: input.kind,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        participantUserIds: participantIds,
      },
      correlationId: options.correlationId,
    });
    const loaded = await requireConversation(tx, identity, conversation!.id);
    if (input.initialMessage) {
      await insertMessage(tx, identity, loaded, { body: input.initialMessage, attachmentFileIds: [], internalOnly: false }, options);
      loaded.conversation.lastMessageAt = new Date();
    }
    return toDetail(tx, loaded, userId);
  });
}

export async function getConversation(identity: RequestIdentity, id: string): Promise<ConversationDetail> {
  const userId = requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const ctx = await requireConversation(tx, identity, id);
    return toDetail(tx, ctx, userId);
  });
}

/** Conversations the caller participates in. Row-level security applies the same rule. */
export async function listConversations(
  identity: RequestIdentity,
  query: ConversationListQuery,
): Promise<Page<ConversationDto>> {
  const userId = requireUserId(identity);
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({ c: schema.conversations, lastReadAt: schema.conversationParticipants.lastReadAt })
      .from(schema.conversations)
      .innerJoin(
        schema.conversationParticipants,
        and(
          eq(schema.conversationParticipants.conversationId, schema.conversations.id),
          eq(schema.conversationParticipants.userId, userId),
          isNull(schema.conversationParticipants.leftAt),
        ),
      )
      .where(
        and(
          query.status === 'open'
            ? isNull(schema.conversations.closedAt)
            : query.status === 'closed'
              ? isNotNull(schema.conversations.closedAt)
              : undefined,
          query.entityType ? eq(schema.conversations.entityType, query.entityType) : undefined,
          query.entityId ? eq(schema.conversations.entityId, query.entityId) : undefined,
          cursor
            ? or(
                lt(schema.conversations.createdAt, cursor.createdAt),
                and(eq(schema.conversations.createdAt, cursor.createdAt), lt(schema.conversations.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.conversations.createdAt), desc(schema.conversations.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const ids = page.map((r) => r.c.id);
    const unread = new Map<string, number>();
    if (ids.length > 0) {
      const counts = await tx
        .select({ conversationId: schema.messages.conversationId, n: count() })
        .from(schema.messages)
        .innerJoin(
          schema.conversationParticipants,
          and(
            eq(schema.conversationParticipants.conversationId, schema.messages.conversationId),
            eq(schema.conversationParticipants.userId, userId),
          ),
        )
        .where(
          and(
            inArray(schema.messages.conversationId, ids),
            or(isNull(schema.messages.senderUserId), ne(schema.messages.senderUserId, userId)),
            sql`(${schema.conversationParticipants.lastReadAt} IS NULL OR ${schema.messages.createdAt} > ${schema.conversationParticipants.lastReadAt})`,
          ),
        )
        .groupBy(schema.messages.conversationId);
      for (const c of counts) unread.set(c.conversationId, Number(c.n));
    }
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: page.map((r) => toDto(r.c, unread.get(r.c.id) ?? 0)),
      nextCursor: last ? encodeCursor(last.c.createdAt, last.c.id) : null,
    };
  });
}

function assertCanManage(identity: RequestIdentity, ctx: ConversationContext, userId: string): void {
  if (isStaffIdentity(identity)) return;
  if (ctx.conversation.createdBy === userId && ctx.self) return;
  throw new ApiError('forbidden', 'only staff or the conversation creator may do this');
}

export async function addParticipant(
  identity: RequestIdentity,
  id: string,
  input: { userId: string },
  options: ServiceOptions = {},
): Promise<ConversationDetail> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const conv = await requireConversation(tx, identity, id);
    assertCanManage(identity, conv, userId);
    if (conv.conversation.closedAt) throw new ApiError('invalid_transition', 'conversation is closed');
    if (activeParticipantIds(conv.participants).includes(input.userId)) {
      throw new ApiError('conflict', 'user is already a participant');
    }
    const entity =
      conv.conversation.entityType && conv.conversation.entityId
        ? await resolveEntity(tx, conv.conversation.entityType as CollaborationEntityType, conv.conversation.entityId)
        : null;
    // Elevation: validating another user's staff role needs a privileged read; the
    // caller's participation/creator rights were established above.
    await elevate(tx, ctx);
    await validateParticipants(
      tx,
      { organizationId: conv.conversation.organizationId, entity },
      conv.conversation.kind,
      [input.userId],
    );
    const existing = conv.participants.find((p) => p.userId === input.userId);
    if (existing) {
      await tx
        .update(schema.conversationParticipants)
        .set({ leftAt: null, joinedAt: new Date() })
        .where(eq(schema.conversationParticipants.id, existing.id));
    } else {
      await tx
        .insert(schema.conversationParticipants)
        .values({ conversationId: id, userId: input.userId, role: 'participant' });
    }
    await recordAudit(tx, identity, {
      action: 'conversation.participant_added',
      entityType: 'conversation',
      entityId: id,
      organizationId: conv.conversation.organizationId,
      after: { userId: input.userId },
      correlationId: options.correlationId,
    });
    return toDetail(tx, await requireConversation(tx, identity, id), userId);
  });
}

export async function removeParticipant(
  identity: RequestIdentity,
  id: string,
  targetUserId: string,
  options: ServiceOptions = {},
): Promise<ConversationDetail> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const conv = await requireConversation(tx, identity, id);
    if (targetUserId !== userId) assertCanManage(identity, conv, userId);
    const target = conv.participants.find((p) => p.userId === targetUserId && p.leftAt === null);
    if (!target) throw new ApiError('not_found', 'participant not found');
    await tx
      .update(schema.conversationParticipants)
      .set({ leftAt: new Date() })
      .where(eq(schema.conversationParticipants.id, target.id));
    await recordAudit(tx, identity, {
      action: 'conversation.participant_removed',
      entityType: 'conversation',
      entityId: id,
      organizationId: conv.conversation.organizationId,
      after: { userId: targetUserId },
      correlationId: options.correlationId,
    });
    if (targetUserId === userId && !isStaffIdentity(identity)) {
      // The caller just left and can no longer read the conversation.
      const names = await userNameMap(tx, conv.participants.map((p) => p.userId));
      return {
        ...toDto(conv.conversation, 0),
        participants: conv.participants.map((p) =>
          toParticipantDto(p.id === target.id ? { ...p, leftAt: new Date() } : p, names),
        ),
      };
    }
    return toDetail(tx, await requireConversation(tx, identity, id), userId);
  });
}

export async function closeConversation(
  identity: RequestIdentity,
  id: string,
  options: ServiceOptions = {},
): Promise<ConversationDetail> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const conv = await requireConversation(tx, identity, id);
    assertCanManage(identity, conv, userId);
    if (conv.conversation.closedAt) throw new ApiError('invalid_transition', 'conversation is already closed');
    await tx
      .update(schema.conversations)
      .set({ closedAt: new Date() })
      .where(and(eq(schema.conversations.id, id), isNull(schema.conversations.closedAt)));
    await recordAudit(tx, identity, {
      action: 'conversation.closed',
      entityType: 'conversation',
      entityId: id,
      organizationId: conv.conversation.organizationId,
      correlationId: options.correlationId,
    });
    return toDetail(tx, await requireConversation(tx, identity, id), userId);
  });
}

export async function markConversationRead(
  identity: RequestIdentity,
  id: string,
): Promise<{ conversationId: string; lastReadAt: string }> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const conv = await requireConversation(tx, identity, id);
    if (!conv.self) throw new ApiError('forbidden', 'only participants track read state');
    const now = new Date();
    await tx
      .update(schema.conversationParticipants)
      .set({ lastReadAt: now })
      .where(eq(schema.conversationParticipants.id, conv.self.id));
    return { conversationId: id, lastReadAt: now.toISOString() };
  });
}

import 'server-only';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type MessageCreate,
  type MessageDto,
  type MessageListQuery,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import {
  assertAllowed,
  authorizeOrg,
  authorizePartner,
  authorizeTenant,
  membershipFor,
} from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  decodeCursor,
  encodeCursor,
  iso,
  isPartnerIdentity,
  isStaffIdentity,
  requireUserId,
  userNameMap,
  type ServiceOptions,
} from '@/server/assignments/shared';
import {
  activeParticipantIds,
  activeStaffAmong,
  requireConversation,
  type ConversationContext,
} from './access';

type MessageRow = typeof schema.messages.$inferSelect;

/**
 * Messages within a conversation. Posting requires participation plus the
 * caller's messaging permission (org.messages.send, tenant.messages.send, a
 * partner account, or staff). Internal-only messages are written and read by
 * staff alone; the messages policy enforces the same rule in SQL.
 */

/** Attachment files must be usable and visible to the sender under their own context. */
const USABLE_FILE_STATUSES = new Set(['uploaded', 'scanning', 'clean']);

export function toMessageDto(row: MessageRow, names: Map<string, string>): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    senderName: row.senderUserId ? (names.get(row.senderUserId) ?? null) : null,
    body: row.body,
    attachmentFileIds: row.attachmentFileIds ?? [],
    internalOnly: row.internalOnly,
    createdAt: row.createdAt.toISOString(),
    editedAt: iso(row.editedAt),
  };
}

function assertCanPost(identity: RequestIdentity, ctx: ConversationContext): void {
  if (!ctx.self) throw new ApiError('forbidden', 'only participants can post messages');
  if (isStaffIdentity(identity)) return;
  const orgId = ctx.conversation.organizationId;
  const membership = orgId ? membershipFor(identity.actor, orgId) : undefined;
  if (membership?.role === 'tenant') {
    assertAllowed(
      authorizeTenant(identity.actor, 'tenant.messages.send', {
        type: 'conversation',
        id: ctx.conversation.id,
        assigneeUserIds: activeParticipantIds(ctx.participants),
      }),
    );
    return;
  }
  if (membership) {
    assertAllowed(
      authorizeOrg(identity.actor, 'org.messages.send', {
        type: 'conversation',
        id: ctx.conversation.id,
        organizationId: orgId,
      }),
    );
    return;
  }
  if (isPartnerIdentity(identity)) {
    assertAllowed(
      authorizePartner(identity.actor, 'partner.assignments.view', {
        type: 'conversation',
        id: ctx.conversation.id,
        assigneeUserIds: activeParticipantIds(ctx.participants),
      }),
    );
    return;
  }
  throw new ApiError('forbidden', 'you may not post in this conversation');
}

async function assertAttachments(tx: DbExecutor, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const rows = await tx
    .select({
      id: schema.fileObjects.id,
      status: schema.fileObjects.status,
      deletedAt: schema.fileObjects.deletedAt,
    })
    .from(schema.fileObjects)
    .where(inArray(schema.fileObjects.id, fileIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of fileIds) {
    const f = byId.get(id);
    if (!f) {
      throw new ApiError('validation_failed', 'attachment is not a file you can access', {
        details: [{ path: 'attachmentFileIds', message: `unknown file ${id}` }],
      });
    }
    if (f.status === 'infected' || f.status === 'scan_failed') {
      throw new ApiError('file_quarantined', 'an attachment is quarantined and cannot be shared');
    }
    if (f.deletedAt || !USABLE_FILE_STATUSES.has(f.status)) {
      throw new ApiError('file_rejected', 'an attachment was rejected, deleted or never uploaded');
    }
  }
}

/** Inserts a message for a caller whose participation and permission are already proven. */
export async function insertMessage(
  tx: DbExecutor,
  identity: RequestIdentity,
  ctx: ConversationContext,
  input: MessageCreate,
  options: ServiceOptions,
): Promise<MessageRow> {
  const userId = requireUserId(identity);
  if (input.internalOnly && !isStaffIdentity(identity)) {
    throw new ApiError('forbidden', 'only staff can post internal messages');
  }
  const [row] = await tx
    .insert(schema.messages)
    .values({
      conversationId: ctx.conversation.id,
      senderUserId: userId,
      body: input.body,
      attachmentFileIds: input.attachmentFileIds,
      internalOnly: input.internalOnly,
    })
    .returning();
  await tx
    .update(schema.conversations)
    .set({ lastMessageAt: row!.createdAt })
    .where(eq(schema.conversations.id, ctx.conversation.id));
  let recipients = activeParticipantIds(ctx.participants).filter((id) => id !== userId);
  if (input.internalOnly) {
    const staff = await activeStaffAmong(tx, recipients);
    recipients = recipients.filter((id) => staff.has(id));
  }
  await appendOutbox(tx, {
    eventType: 'message.posted',
    aggregateType: 'conversation',
    aggregateId: ctx.conversation.id,
    organizationId: ctx.conversation.organizationId,
    actorUserId: userId,
    payload: {
      messageId: row!.id,
      conversationId: ctx.conversation.id,
      organizationId: ctx.conversation.organizationId,
      senderUserId: userId,
      internalOnly: input.internalOnly,
      hasAttachments: input.attachmentFileIds.length > 0,
      recipientUserIds: recipients,
    },
    correlationId: options.correlationId ?? null,
  });
  await recordAudit(tx, identity, {
    action: 'message.posted',
    entityType: 'conversation',
    entityId: ctx.conversation.id,
    organizationId: ctx.conversation.organizationId,
    after: {
      messageId: row!.id,
      internalOnly: input.internalOnly,
      attachments: input.attachmentFileIds.length,
    },
    correlationId: options.correlationId,
  });
  return row!;
}

export async function postMessage(
  identity: RequestIdentity,
  conversationId: string,
  input: MessageCreate,
  options: ServiceOptions = {},
): Promise<MessageDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const conv = await requireConversation(tx, identity, conversationId);
    assertCanPost(identity, conv);
    if (conv.conversation.closedAt)
      throw new ApiError('invalid_transition', 'conversation is closed');
    await assertAttachments(tx, input.attachmentFileIds);
    const row = await insertMessage(tx, identity, conv, input, options);
    const names = await userNameMap(tx, [userId]);
    return toMessageDto(row, names);
  });
}

/** Newest first with a keyset cursor; internal-only messages are filtered for non-staff in SQL. */
export async function listMessages(
  identity: RequestIdentity,
  conversationId: string,
  query: MessageListQuery,
): Promise<Page<MessageDto>> {
  requireUserId(identity);
  const cursor = decodeCursor(query.cursor);
  return withActor(getDb(), identity.ctx, async (tx) => {
    await requireConversation(tx, identity, conversationId);
    const rows = await tx
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          isStaffIdentity(identity) ? undefined : eq(schema.messages.internalOnly, false),
          cursor
            ? or(
                lt(schema.messages.createdAt, cursor.createdAt),
                and(
                  eq(schema.messages.createdAt, cursor.createdAt),
                  lt(schema.messages.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const names = await userNameMap(
      tx,
      page.map((m) => m.senderUserId),
    );
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return {
      items: page.map((m) => toMessageDto(m, names)),
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

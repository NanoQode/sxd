import 'server-only';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ConversationDetail, MessageDto } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { listMessages } from '@/server/conversations/messages';
import { getConversation } from '@/server/conversations/service';
import { listStaffAssignees } from '@/server/leads/admin';
import { can, iso, orgNames, requireAnyStaff, staffTx, userIdOf, userNames } from './context';

export interface InboxRow {
  id: string;
  kind: string;
  subject: string;
  organizationId: string | null;
  organizationName: string | null;
  entityType: string | null;
  entityId: string | null;
  lastMessageAt: string | null;
  closedAt: string | null;
  createdAt: string;
  participantNames: string[];
  amParticipant: boolean;
  unreadCount: number;
  lastMessagePreview: string | null;
  messageCount: number;
}

/**
 * Staff inbox. With `messages.read_all` every conversation is listed; other
 * staff (support) see only conversations they take part in.
 */
export async function staffInbox(
  identity: RequestIdentity,
  filters: {
    status: 'open' | 'closed' | 'all';
    kind?: string;
    mine?: boolean;
    q?: string;
    page: number;
    pageSize: number;
  },
): Promise<{ items: InboxRow[]; total: number; readAll: boolean }> {
  requireAnyStaff(identity, ['messages.read_all', 'support.tickets.read']);
  const me = userIdOf(identity);
  const readAll = can(identity, 'messages.read_all');
  return staffTx(identity, async (tx) => {
    const mineIds = (
      await tx
        .select({ id: schema.conversationParticipants.conversationId })
        .from(schema.conversationParticipants)
        .where(
          and(
            eq(schema.conversationParticipants.userId, me),
            isNull(schema.conversationParticipants.leftAt),
          ),
        )
    ).map((r) => r.id);
    const restrictToMine = !readAll || filters.mine;
    if (restrictToMine && mineIds.length === 0) return { items: [], total: 0, readAll };
    const where = and(
      filters.status === 'open'
        ? isNull(schema.conversations.closedAt)
        : filters.status === 'closed'
          ? isNotNull(schema.conversations.closedAt)
          : undefined,
      filters.kind ? eq(schema.conversations.kind, filters.kind as never) : undefined,
      restrictToMine ? inArray(schema.conversations.id, mineIds) : undefined,
      filters.q
        ? sql`${schema.conversations.subject} ilike ${`%${filters.q.replace(/[%_]/g, '')}%`}`
        : undefined,
    );
    const [totalRow] = await tx.select({ n: count() }).from(schema.conversations).where(where);
    const rows = await tx
      .select()
      .from(schema.conversations)
      .where(where)
      .orderBy(
        sql`${schema.conversations.lastMessageAt} desc nulls last`,
        desc(schema.conversations.createdAt),
      )
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { items: [], total: Number(totalRow?.n ?? 0), readAll };
    const participants = await tx
      .select({
        conversationId: schema.conversationParticipants.conversationId,
        userId: schema.conversationParticipants.userId,
        lastReadAt: schema.conversationParticipants.lastReadAt,
        name: schema.user.name,
      })
      .from(schema.conversationParticipants)
      .innerJoin(schema.user, eq(schema.user.id, schema.conversationParticipants.userId))
      .where(
        and(
          inArray(schema.conversationParticipants.conversationId, ids),
          isNull(schema.conversationParticipants.leftAt),
        ),
      );
    const lastMessages = await tx
      .select({
        conversationId: schema.messages.conversationId,
        body: schema.messages.body,
        createdAt: schema.messages.createdAt,
        senderUserId: schema.messages.senderUserId,
        internalOnly: schema.messages.internalOnly,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.conversationId, ids))
      .orderBy(desc(schema.messages.createdAt));
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.organizationId),
    );
    const byConv = new Map<
      string,
      Array<{ userId: string; name: string; lastReadAt: Date | null }>
    >();
    for (const p of participants) {
      const list = byConv.get(p.conversationId) ?? [];
      list.push({ userId: p.userId, name: p.name, lastReadAt: p.lastReadAt ?? null });
      byConv.set(p.conversationId, list);
    }
    const preview = new Map<string, string>();
    const msgCount = new Map<string, number>();
    const unread = new Map<string, number>();
    for (const m of lastMessages) {
      if (!preview.has(m.conversationId)) preview.set(m.conversationId, m.body.slice(0, 140));
      msgCount.set(m.conversationId, (msgCount.get(m.conversationId) ?? 0) + 1);
      const mine = byConv.get(m.conversationId)?.find((p) => p.userId === me);
      if (mine && m.senderUserId !== me && (!mine.lastReadAt || m.createdAt > mine.lastReadAt)) {
        unread.set(m.conversationId, (unread.get(m.conversationId) ?? 0) + 1);
      }
    }
    return {
      readAll,
      total: Number(totalRow?.n ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        subject: r.subject,
        organizationId: r.organizationId ?? null,
        organizationName: r.organizationId ? (orgs.get(r.organizationId) ?? null) : null,
        entityType: r.entityType ?? null,
        entityId: r.entityId ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        closedAt: iso(r.closedAt),
        createdAt: r.createdAt.toISOString(),
        participantNames: (byConv.get(r.id) ?? []).map((p) => p.name),
        amParticipant: (byConv.get(r.id) ?? []).some((p) => p.userId === me),
        unreadCount: unread.get(r.id) ?? 0,
        lastMessagePreview: preview.get(r.id) ?? null,
        messageCount: msgCount.get(r.id) ?? 0,
      })),
    };
  });
}

export interface ThreadView {
  conversation: ConversationDetail;
  messages: MessageDto[];
  nextCursor: string | null;
  amParticipant: boolean;
  organizationName: string | null;
  staff: Array<{ userId: string; name: string }>;
  orgMembers: Array<{ userId: string; name: string; role: string }>;
  permissions: { readAll: boolean };
}

/**
 * Thread for staff. Participants use the collaboration service; a staff
 * member with `messages.read_all` who is not a participant reads the
 * conversation directly (row-level security permits staff) and is told they
 * must join before replying.
 */
export async function staffThread(
  identity: RequestIdentity,
  conversationId: string,
): Promise<ThreadView | null> {
  requireAnyStaff(identity, ['messages.read_all', 'support.tickets.read']);
  const me = userIdOf(identity);
  const readAll = can(identity, 'messages.read_all');
  const staff = await listStaffAssignees(identity);
  const participantView = await getConversation(identity, conversationId).catch(() => null);
  if (participantView) {
    const [page, extra] = await Promise.all([
      listMessages(identity, conversationId, { limit: 100 }),
      staffTx(identity, async (tx) => threadExtras(tx, participantView.organizationId)),
    ]);
    return {
      conversation: participantView,
      messages: [...page.items].reverse(),
      nextCursor: page.nextCursor,
      amParticipant: participantView.participants.some((p) => p.userId === me && !p.leftAt),
      organizationName: extra.organizationName,
      staff: staff.map((s) => ({ userId: s.userId, name: s.name })),
      orgMembers: extra.members,
      permissions: { readAll },
    };
  }
  if (!readAll) return null;
  return staffTx(identity, async (tx) => {
    const [c] = await tx
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    if (!c) return null;
    const participants = await tx
      .select({ p: schema.conversationParticipants, name: schema.user.name })
      .from(schema.conversationParticipants)
      .innerJoin(schema.user, eq(schema.user.id, schema.conversationParticipants.userId))
      .where(eq(schema.conversationParticipants.conversationId, conversationId))
      .orderBy(asc(schema.conversationParticipants.joinedAt));
    const msgs = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt))
      .limit(200);
    const names = await userNames(
      tx,
      msgs.map((m) => m.senderUserId),
    );
    const extra = await threadExtras(tx, c.organizationId ?? null);
    const conversation: ConversationDetail = {
      id: c.id,
      organizationId: c.organizationId ?? null,
      kind: c.kind,
      subject: c.subject,
      entityType: c.entityType ?? null,
      entityId: c.entityId ?? null,
      createdBy: c.createdBy ?? null,
      lastMessageAt: iso(c.lastMessageAt),
      closedAt: iso(c.closedAt),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      unreadCount: 0,
      participants: participants.map((p) => ({
        userId: p.p.userId,
        name: p.name,
        role: p.p.role,
        joinedAt: p.p.joinedAt.toISOString(),
        lastReadAt: iso(p.p.lastReadAt),
        leftAt: iso(p.p.leftAt),
      })),
    };
    return {
      conversation,
      messages: msgs.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderUserId: m.senderUserId ?? null,
        senderName: m.senderUserId ? (names.get(m.senderUserId)?.name ?? null) : null,
        body: m.body,
        attachmentFileIds: Array.isArray(m.attachmentFileIds)
          ? (m.attachmentFileIds as string[])
          : [],
        internalOnly: Boolean(m.internalOnly),
        createdAt: m.createdAt.toISOString(),
        editedAt: iso(m.editedAt),
      })),
      nextCursor: null,
      amParticipant: false,
      organizationName: extra.organizationName,
      staff: staff.map((s) => ({ userId: s.userId, name: s.name })),
      orgMembers: extra.members,
      permissions: { readAll },
    };
  });
}

async function threadExtras(
  tx: Parameters<Parameters<typeof staffTx>[1]>[0],
  organizationId: string | null,
) {
  if (!organizationId) return { organizationName: null, members: [] };
  const [org] = await tx
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId));
  const members = await tx
    .select({ userId: schema.member.userId, name: schema.user.name, role: schema.member.role })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, organizationId))
    .orderBy(asc(schema.user.name));
  return { organizationName: org?.name ?? null, members };
}

/** Organisation owners/members for starting a support conversation. */
export async function organizationMembers(identity: RequestIdentity, organizationId: string) {
  requireAnyStaff(identity, ['customers.read']);
  return staffTx(identity, (tx) =>
    tx
      .select({ userId: schema.member.userId, name: schema.user.name, role: schema.member.role })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, organizationId))
      .orderBy(asc(schema.user.name)),
  );
}

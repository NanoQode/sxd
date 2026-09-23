import 'server-only';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type DbExecutor } from '@simplexd/db';
import { authorizeStaff } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { uniqueIds } from '@/server/assignments/shared';

export type ConversationRow = typeof schema.conversations.$inferSelect;
export type ParticipantRow = typeof schema.conversationParticipants.$inferSelect;

export interface ConversationContext {
  conversation: ConversationRow;
  /** All participant rows, including those who left. */
  participants: ParticipantRow[];
  /** The caller's own participant row, or null for a staff observer. */
  self: ParticipantRow | null;
  /** True for staff reading through messages.read_all without being a participant. */
  observer: boolean;
}

export function activeParticipantIds(participants: ParticipantRow[]): string[] {
  return uniqueIds(participants.filter((p) => p.leftAt === null).map((p) => p.userId));
}

/**
 * Loads a conversation the caller may see. Row-level security already hides
 * conversations from non-participants (staff excepted); on top of that, staff
 * who are not participants need `messages.read_all`. Anything else is
 * reported as `not_found` so ids cannot be probed.
 */
export async function requireConversation(
  tx: DbExecutor,
  identity: RequestIdentity,
  id: string,
): Promise<ConversationContext> {
  const userId = identity.session?.user.id;
  if (!userId) throw new ApiError('unauthenticated', 'sign in required');
  const [conversation] = await tx
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id));
  if (!conversation) throw new ApiError('not_found', 'conversation not found');
  const participants = await tx
    .select()
    .from(schema.conversationParticipants)
    .where(eq(schema.conversationParticipants.conversationId, id))
    .orderBy(asc(schema.conversationParticipants.joinedAt), asc(schema.conversationParticipants.id));
  const self = participants.find((p) => p.userId === userId && p.leftAt === null) ?? null;
  if (self) return { conversation, participants, self, observer: false };
  const observer =
    identity.actor.staffRoles.length > 0 &&
    authorizeStaff(identity.actor, 'messages.read_all', {
      type: 'conversation',
      id,
      organizationId: conversation.organizationId,
    }).allowed;
  if (!observer) throw new ApiError('not_found', 'conversation not found');
  return { conversation, participants, self: null, observer: true };
}

/** Members of an organisation (the member table carries no row-level policy). */
export async function orgMembers(
  tx: DbExecutor,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return new Map(rows.map((r) => [r.userId, r.role]));
}

/** Users holding an active staff role. Readable in full only by privileged contexts. */
export async function activeStaffAmong(tx: DbExecutor, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .select({ userId: schema.staffRoles.userId })
    .from(schema.staffRoles)
    .where(and(inArray(schema.staffRoles.userId, userIds), isNull(schema.staffRoles.revokedAt)));
  return new Set(rows.map((r) => r.userId));
}

export async function existingUsers(tx: DbExecutor, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(inArray(schema.user.id, userIds));
  return new Set(rows.map((r) => r.id));
}

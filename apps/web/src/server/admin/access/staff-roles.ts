import 'server-only';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { StaffRole } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import { actorId, authorize, iso, transact, type AdminContext } from '../context';

export interface StaffUserDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  banned: boolean;
  roles: Array<{
    id: string;
    role: StaffRole;
    grantedAt: string;
    grantedBy: string | null;
    reason: string | null;
  }>;
}

/** Users holding at least one active staff role, or matching `q` (for granting). */
export async function listStaffUsers(
  ctx: AdminContext,
  query: { q?: string; limit: number },
): Promise<StaffUserDto[]> {
  authorize(ctx, 'access.staff_roles.manage');
  return transact(ctx, async (tx) => {
    const pattern = query.q ? `%${query.q.replace(/[%_]/g, '')}%` : null;
    const users = await tx
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
        twoFactorEnabled: schema.user.twoFactorEnabled,
        banned: schema.user.banned,
      })
      .from(schema.user)
      .where(
        pattern
          ? or(ilike(schema.user.email, pattern), ilike(schema.user.name, pattern))
          : sql`exists (select 1 from staff_roles r where r.user_id = ${schema.user.id} and r.revoked_at is null)`,
      )
      .orderBy(asc(schema.user.name))
      .limit(query.limit);
    if (users.length === 0) return [];
    const roles = await tx
      .select()
      .from(schema.staffRoles)
      .where(
        and(
          isNull(schema.staffRoles.revokedAt),
          sql`${schema.staffRoles.userId} = any(${users.map((u) => u.id)}::text[])`,
        ),
      );
    const byUser = new Map<string, StaffUserDto['roles']>();
    for (const r of roles) {
      const list = byUser.get(r.userId) ?? [];
      list.push({
        id: r.id,
        role: r.role,
        grantedAt: r.grantedAt.toISOString(),
        grantedBy: r.grantedBy,
        reason: r.reason,
      });
      byUser.set(r.userId, list);
    }
    return users.map((u) => ({
      ...u,
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
      banned: Boolean(u.banned),
      roles: byUser.get(u.id) ?? [],
    }));
  });
}

export async function changeStaffRole(
  ctx: AdminContext,
  input: {
    action: 'grant' | 'revoke';
    userId?: string;
    email?: string;
    role: StaffRole;
    reason: string;
  },
): Promise<StaffUserDto> {
  authorize(ctx, 'access.staff_roles.manage');
  const actor = actorId(ctx);
  const userId = await transact(ctx, async (tx) => {
    const target = input.userId
      ? await tx
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, input.userId))
      : await tx
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(sql`lower(${schema.user.email}) = ${input.email!.toLowerCase()}`);
    const user = target[0];
    if (!user) throw new ApiError('not_found', 'user not found; they must create an account first');
    const active = await tx
      .select()
      .from(schema.staffRoles)
      .where(
        and(
          eq(schema.staffRoles.userId, user.id),
          eq(schema.staffRoles.role, input.role),
          isNull(schema.staffRoles.revokedAt),
        ),
      );
    if (input.action === 'grant') {
      if (active.length > 0) throw new ApiError('conflict', `user already holds ${input.role}`);
      const [row] = await tx
        .insert(schema.staffRoles)
        .values({ userId: user.id, role: input.role, grantedBy: actor, reason: input.reason })
        .returning();
      await recordAudit(tx, ctx.identity, {
        action: 'staff_role.granted',
        entityType: 'user',
        entityId: user.id,
        after: { role: input.role, staffRoleId: row!.id },
        reason: input.reason,
        correlationId: ctx.correlationId,
      });
    } else {
      const current = active[0];
      if (!current) throw new ApiError('not_found', `user does not hold ${input.role}`);
      if (input.role === 'super_admin') {
        if (user.id === actor)
          throw new ApiError('forbidden', 'you cannot revoke your own super administrator role');
        const admins = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.staffRoles)
          .where(
            and(eq(schema.staffRoles.role, 'super_admin'), isNull(schema.staffRoles.revokedAt)),
          );
        if ((admins[0]?.n ?? 0) <= 1)
          throw new ApiError('conflict', 'the last super administrator cannot be revoked');
      }
      await tx
        .update(schema.staffRoles)
        .set({ revokedAt: new Date(), revokedBy: actor, reason: input.reason })
        .where(eq(schema.staffRoles.id, current.id));
      await recordAudit(tx, ctx.identity, {
        action: 'staff_role.revoked',
        entityType: 'user',
        entityId: user.id,
        before: { role: input.role, staffRoleId: current.id },
        after: { role: input.role, revokedAt: iso(new Date()) },
        reason: input.reason,
        correlationId: ctx.correlationId,
      });
    }
    return user.id;
  });
  const users = await listStaffUsers(ctx, { q: undefined, limit: 500 });
  const found = users.find((u) => u.id === userId);
  if (found) return found;
  // A user whose last role was revoked no longer appears in the staff list.
  const byId = await transact(ctx, (tx) =>
    tx
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
        twoFactorEnabled: schema.user.twoFactorEnabled,
        banned: schema.user.banned,
      })
      .from(schema.user)
      .where(eq(schema.user.id, userId)),
  );
  const u = byId[0]!;
  return {
    ...u,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
    banned: Boolean(u.banned),
    roles: [],
  };
}

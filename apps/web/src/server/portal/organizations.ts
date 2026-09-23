import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  type OrganizationInvitationDto,
  type OrganizationMemberDto,
  type OrganizationMembershipDto,
  organizationInviteSchema,
  organizationUpdateSchema,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { assertOrgPermission, requireActiveOrganization } from './access';
import { elevate } from './elevate';

const INVITATION_TTL_MS = 7 * 86_400_000;

function normalizeRole(role: string): OrganizationMembershipDto['role'] {
  const known: OrganizationMembershipDto['role'][] = ['owner', 'member', 'adviser', 'approver', 'tenant'];
  if ((known as string[]).includes(role)) return role as OrganizationMembershipDto['role'];
  if (role === 'admin') return 'owner';
  return 'member';
}

/** The user's memberships with organisation names; the active one is flagged. */
export async function listMemberships(identity: RequestIdentity): Promise<OrganizationMembershipDto[]> {
  if (!identity.session) return [];
  const userId = identity.session.user.id;
  const activeId = identity.ctx.organizationId;
  return withActor(getDb(), identity.ctx, async (tx) => {
    // Profiles of non-active organisations are hidden by row-level security; the
    // user's own memberships are safe to read elevated because the query is
    // constrained to their user id.
    await elevate(tx, identity.ctx);
    const rows = await tx
      .select({ m: schema.member, org: schema.organization, profile: schema.organizationProfiles })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .leftJoin(schema.organizationProfiles, eq(schema.organizationProfiles.organizationId, schema.member.organizationId))
      .where(eq(schema.member.userId, userId))
      .orderBy(schema.member.createdAt);
    return rows.map((r) => ({
      organizationId: r.org.id,
      name: r.org.name,
      slug: r.org.slug,
      role: normalizeRole(r.m.role),
      kind: r.profile?.kind ?? 'customer',
      ownershipType: r.profile?.ownershipType ?? 'individual',
      isActive: r.org.id === activeId,
      createdAt: r.m.createdAt.toISOString(),
    }));
  });
}

export async function updateActiveOrganization(
  identity: RequestIdentity,
  input: z.infer<typeof organizationUpdateSchema>,
  options: { correlationId: string },
): Promise<OrganizationMembershipDto> {
  const orgId = requireActiveOrganization(identity);
  assertOrgPermission(identity, 'org.settings.manage', { type: 'organization', id: orgId, organizationId: orgId });
  const parsed = organizationUpdateSchema.parse(input);
  await withActor(getDb(), identity.ctx, async (tx) => {
    const [before] = await tx
      .select({ name: schema.organization.name, profile: schema.organizationProfiles })
      .from(schema.organization)
      .leftJoin(schema.organizationProfiles, eq(schema.organizationProfiles.organizationId, schema.organization.id))
      .where(eq(schema.organization.id, orgId));
    if (!before) throw new ApiError('not_found', 'organisation not found');
    if (parsed.name) {
      await tx.update(schema.organization).set({ name: parsed.name }).where(eq(schema.organization.id, orgId));
    }
    await tx
      .insert(schema.organizationProfiles)
      .values({ organizationId: orgId, kind: 'customer' })
      .onConflictDoNothing();
    if (parsed.ownershipType || parsed.legalName !== undefined) {
      await tx
        .update(schema.organizationProfiles)
        .set({
          ...(parsed.ownershipType ? { ownershipType: parsed.ownershipType } : {}),
          ...(parsed.legalName !== undefined ? { legalName: parsed.legalName } : {}),
        })
        .where(eq(schema.organizationProfiles.organizationId, orgId));
    }
    await elevate(tx, identity.ctx);
    await recordAudit(tx, identity, {
      action: 'organization.updated',
      entityType: 'organization',
      entityId: orgId,
      organizationId: orgId,
      before: { name: before.name, ownershipType: before.profile?.ownershipType, legalName: before.profile?.legalName },
      after: parsed,
      correlationId: options.correlationId,
    });
  });
  const memberships = await listMemberships(identity);
  return memberships.find((m) => m.organizationId === orgId)!;
}

export async function listMembers(identity: RequestIdentity): Promise<OrganizationMemberDto[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId || !identity.session) return [];
  assertOrgPermission(identity, 'org.read', { type: 'organization', id: orgId, organizationId: orgId });
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ m: schema.member, name: schema.user.name, email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(schema.member.createdAt),
  );
  return rows.map((r) => ({
    id: r.m.id,
    userId: r.m.userId,
    name: r.name,
    email: r.email,
    role: normalizeRole(r.m.role),
    createdAt: r.m.createdAt.toISOString(),
  }));
}

export async function listPendingInvitations(identity: RequestIdentity): Promise<OrganizationInvitationDto[]> {
  const orgId = identity.ctx.organizationId;
  if (!orgId || !identity.session) return [];
  assertOrgPermission(identity, 'org.read', { type: 'organization', id: orgId, organizationId: orgId });
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ i: schema.invitation, inviterName: schema.user.name })
      .from(schema.invitation)
      .leftJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
      .where(and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, 'pending')))
      .orderBy(desc(schema.invitation.createdAt)),
  );
  return rows.map((r) => ({
    id: r.i.id,
    email: r.i.email,
    role: r.i.role ?? 'member',
    status: r.i.expiresAt < new Date() ? 'expired' : r.i.status,
    expiresAt: r.i.expiresAt.toISOString(),
    createdAt: r.i.createdAt.toISOString(),
    inviterName: r.inviterName,
  }));
}

/**
 * Invitations use SimplexD's organisation roles (owner, member, adviser,
 * approver), which better-auth's default role registry does not know, so the
 * invitation row is written directly and the email is queued through the same
 * outbox event the auth plugin uses. Acceptance still goes through
 * better-auth (`organization.acceptInvitation`), which copies the role.
 */
export async function inviteMember(
  identity: RequestIdentity,
  input: z.infer<typeof organizationInviteSchema>,
  options: { correlationId: string },
): Promise<OrganizationInvitationDto> {
  const orgId = requireActiveOrganization(identity);
  assertOrgPermission(identity, 'org.members.invite', { type: 'organization', id: orgId, organizationId: orgId });
  const parsed = organizationInviteSchema.parse(input);
  const inviterId = identity.session!.user.id;
  const inviterName = identity.session!.user.name;
  const email = parsed.email.toLowerCase();
  const myRole = identity.actor.memberships.find((m) => m.organizationId === orgId)?.role;
  if (parsed.role === 'owner' && myRole !== 'owner') {
    throw new ApiError('forbidden', 'only an owner can invite another owner');
  }
  return withActor(getDb(), identity.ctx, async (tx) => {
    const [org] = await tx.select().from(schema.organization).where(eq(schema.organization.id, orgId));
    if (!org) throw new ApiError('not_found', 'organisation not found');
    const existingMember = await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(and(eq(schema.member.organizationId, orgId), sql`lower(${schema.user.email}) = ${email}`));
    if (existingMember.length > 0) throw new ApiError('conflict', 'this person is already a member');
    const pending = await tx
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, orgId),
          eq(schema.invitation.status, 'pending'),
          sql`lower(${schema.invitation.email}) = ${email}`,
          sql`${schema.invitation.expiresAt} > now()`,
        ),
      );
    if (pending.length > 0) throw new ApiError('conflict', 'an invitation for this email is already pending');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await tx.insert(schema.invitation).values({
      id,
      organizationId: orgId,
      email,
      role: parsed.role,
      status: 'pending',
      expiresAt,
      inviterId,
    });
    await elevate(tx, identity.ctx);
    const inviteUrl = `${env().APP_URL}/invitations/${id}`;
    await appendOutbox(tx, {
      eventType: 'notification.requested',
      aggregateType: 'auth',
      aggregateId: email,
      organizationId: orgId,
      actorUserId: inviterId,
      payload: {
        kind: 'invitation',
        channel: 'email',
        category: 'transactional',
        email,
        inviterName,
        organizationName: org.name,
        role: parsed.role,
        invitationId: id,
        inviteUrl,
        expiresAt: expiresAt.toISOString(),
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'invitation.created',
      aggregateType: 'invitation',
      aggregateId: id,
      organizationId: orgId,
      actorUserId: inviterId,
      payload: { email, role: parsed.role },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'organization.member_invited',
      entityType: 'invitation',
      entityId: id,
      organizationId: orgId,
      after: { email, role: parsed.role, expiresAt: expiresAt.toISOString() },
      correlationId: options.correlationId,
    });
    return {
      id,
      email,
      role: parsed.role,
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
      inviterName,
    };
  });
}

export async function revokeInvitation(
  identity: RequestIdentity,
  invitationId: string,
  options: { correlationId: string },
): Promise<void> {
  const orgId = requireActiveOrganization(identity);
  assertOrgPermission(identity, 'org.members.invite', { type: 'organization', id: orgId, organizationId: orgId });
  await withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .update(schema.invitation)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(schema.invitation.id, invitationId),
          eq(schema.invitation.organizationId, orgId),
          eq(schema.invitation.status, 'pending'),
        ),
      )
      .returning({ id: schema.invitation.id, email: schema.invitation.email });
    const row = rows[0];
    if (!row) throw new ApiError('not_found', 'pending invitation not found');
    await elevate(tx, identity.ctx);
    await recordAudit(tx, identity, {
      action: 'organization.invitation_revoked',
      entityType: 'invitation',
      entityId: row.id,
      organizationId: orgId,
      before: { status: 'pending', email: row.email },
      after: { status: 'canceled' },
      correlationId: options.correlationId,
    });
  });
}

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled' | 'expired';
  expiresAt: string;
  organizationName: string;
  inviterName: string | null;
}

/** Public-safe view of an invitation for the accept page (no personal data beyond the invite itself). */
export async function getInvitationView(id: string, identity: RequestIdentity): Promise<InvitationView | null> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ i: schema.invitation, orgName: schema.organization.name, inviterName: schema.user.name })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .leftJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
      .where(eq(schema.invitation.id, id)),
  );
  const row = rows[0];
  if (!row) return null;
  const status = (
    row.i.status === 'pending' && row.i.expiresAt < new Date() ? 'expired' : row.i.status
  ) as InvitationView['status'];
  return {
    id: row.i.id,
    email: row.i.email,
    role: row.i.role ?? 'member',
    status,
    expiresAt: row.i.expiresAt.toISOString(),
    organizationName: row.orgName,
    inviterName: row.inviterName,
  };
}

import { schema, type Database } from '@simplexd/db';
import type { StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Fixtures for the tendering and procurement integration tests: synthetic
 * request identities (never `getIdentity()`), users, organisations, partner
 * profiles and the two expansion feature flags.
 */

export const TENDERING_FLAG = 'expansion.contractor_tendering';
export const PROCUREMENT_FLAG = 'expansion.materials_procurement';

export const enabledFlags: Record<string, boolean> = {
  [TENDERING_FLAG]: true,
  [PROCUREMENT_FLAG]: true,
};

function fakeSession(userId: string): RequestIdentity['session'] {
  const expiresAt = new Date(Date.now() + 3_600_000);
  return {
    user: { id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true },
    session: { id: `session_${userId}`, userId, expiresAt, token: `token_${userId}` },
  } as unknown as RequestIdentity['session'];
}

export function staffIdentity(
  userId: string,
  roles: StaffRole[],
  options: { mfaVerified?: boolean; flags?: Record<string, boolean> } = {},
): RequestIdentity {
  const flags = options.flags ?? enabledFlags;
  return {
    session: fakeSession(userId),
    actor: {
      userId,
      staffRoles: roles,
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: options.mfaVerified ?? true,
      impersonation: null,
      flags,
    },
    ctx: { userId, organizationId: null, staff: true, anonymousToken: null, correlationId: 'test' },
    profile: null,
    featureFlags: flags,
  };
}

export function partnerIdentity(
  userId: string,
  flags: Record<string, boolean> = enabledFlags,
): RequestIdentity {
  return {
    session: fakeSession(userId),
    actor: {
      userId,
      staffRoles: [],
      memberships: [],
      activeOrganizationId: null,
      isPartner: true,
      mfaVerified: false,
      impersonation: null,
      flags,
    },
    ctx: {
      userId,
      organizationId: null,
      staff: false,
      anonymousToken: null,
      correlationId: 'test',
    },
    profile: null,
    featureFlags: flags,
  };
}

export function customerIdentity(
  userId: string,
  organizationId: string,
  role: 'owner' | 'member' | 'approver' = 'owner',
  flags: Record<string, boolean> = enabledFlags,
): RequestIdentity {
  return {
    session: fakeSession(userId),
    actor: {
      userId,
      staffRoles: [],
      memberships: [{ organizationId, role }],
      activeOrganizationId: organizationId,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags,
    },
    ctx: { userId, organizationId, staff: false, anonymousToken: null, correlationId: 'test' },
    profile: null,
    featureFlags: flags,
  };
}

export async function insertUser(owner: Database, id: string): Promise<void> {
  await owner
    .insert(schema.user)
    .values({ id, name: id, email: `${id}@example.test`, emailVerified: true })
    .onConflictDoNothing();
}

export async function insertStaff(owner: Database, id: string, roles: StaffRole[]): Promise<void> {
  await insertUser(owner, id);
  await owner
    .insert(schema.staffRoles)
    .values(roles.map((role) => ({ userId: id, role, reason: 'integration test' })));
}

export async function insertPartner(
  owner: Database,
  id: string,
  partnerType: 'contractor' | 'vendor' = 'contractor',
): Promise<void> {
  await insertUser(owner, id);
  await owner
    .insert(schema.partnerProfiles)
    .values({ userId: id, partnerType, displayName: id, verificationStatus: 'verified' });
}

export async function insertOrganization(
  owner: Database,
  id: string,
  members: Array<{ userId: string; role: string }>,
): Promise<void> {
  await owner.insert(schema.organization).values({ id, name: id, slug: id });
  await owner.insert(schema.organizationProfiles).values({ organizationId: id, kind: 'customer' });
  for (const m of members) {
    await insertUser(owner, m.userId);
    await owner.insert(schema.member).values({
      id: `member_${id}_${m.userId}`,
      organizationId: id,
      userId: m.userId,
      role: m.role,
    });
  }
}

export async function enableCommercialFlags(owner: Database): Promise<void> {
  for (const key of [TENDERING_FLAG, PROCUREMENT_FLAG]) {
    await owner
      .insert(schema.featureFlags)
      .values({ key, name: key, category: 'expansion', enabled: true })
      .onConflictDoUpdate({ target: schema.featureFlags.key, set: { enabled: true } });
  }
}

export const hoursFromNow = (h: number): string =>
  new Date(Date.now() + h * 3_600_000).toISOString();

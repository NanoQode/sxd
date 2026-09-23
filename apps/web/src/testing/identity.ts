import type { OrgRole, StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import type { Session } from '@/lib/auth/server';

/**
 * Builds RequestIdentity values for integration tests without a browser
 * session. The shape mirrors lib/auth/session.ts; only the fields the server
 * modules read are populated.
 */

function fakeSession(
  user: { id: string; email: string; name: string },
  activeOrganizationId: string | null,
): Session {
  const now = new Date();
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `sess_${user.id}`,
      userId: user.id,
      token: `token_${user.id}`,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
      activeOrganizationId,
    },
  } as unknown as Session;
}

export function customerIdentity(input: {
  userId: string;
  email: string;
  name?: string;
  organizationId: string | null;
  role?: OrgRole;
  memberships?: Array<{ organizationId: string; role: OrgRole }>;
  flags?: Record<string, boolean>;
  timeZone?: string;
}): RequestIdentity {
  const memberships =
    input.memberships ??
    (input.organizationId
      ? [{ organizationId: input.organizationId, role: input.role ?? 'owner' }]
      : []);
  const name = input.name ?? input.email.split('@')[0]!;
  return {
    session: fakeSession({ id: input.userId, email: input.email, name }, input.organizationId),
    actor: {
      userId: input.userId,
      staffRoles: [],
      memberships,
      activeOrganizationId: input.organizationId,
      isPartner: false,
      mfaVerified: false,
      impersonation: null,
      flags: input.flags ?? {},
    },
    ctx: {
      userId: input.userId,
      organizationId: input.organizationId,
      staff: false,
      anonymousToken: null,
    },
    profile: null,
    featureFlags: input.flags ?? {},
  };
}

export function staffIdentity(input: {
  userId: string;
  email: string;
  name?: string;
  roles: StaffRole[];
  mfaVerified?: boolean;
  flags?: Record<string, boolean>;
}): RequestIdentity {
  const name = input.name ?? input.email.split('@')[0]!;
  return {
    session: fakeSession({ id: input.userId, email: input.email, name }, null),
    actor: {
      userId: input.userId,
      staffRoles: input.roles,
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: input.mfaVerified ?? true,
      impersonation: null,
      flags: input.flags ?? {},
    },
    ctx: { userId: input.userId, organizationId: null, staff: true, anonymousToken: null },
    profile: null,
    featureFlags: input.flags ?? {},
  };
}

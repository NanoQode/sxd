import type { Database } from '@simplexd/db';
import { schema } from '@simplexd/db';
import type { StaffRole } from '@simplexd/domain/authz';
import type { Session } from '@/lib/auth/server';
import type { RequestIdentity } from '@/lib/auth/session';
import type { AdminContext } from './context';

/**
 * Test helpers: build request identities without HTTP or better-auth so the
 * admin server functions can be exercised directly against the test database.
 */

export function identityFor(
  user: { id: string; name: string; email: string },
  roles: StaffRole[],
  options: { mfaVerified?: boolean } = {},
): RequestIdentity {
  const now = new Date();
  const session = {
    session: {
      id: `sess_${user.id}`,
      userId: user.id,
      token: `tok_${user.id}`,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
      twoFactorEnabled: options.mfaVerified ?? true,
    },
  } as unknown as Session;
  return {
    session,
    actor: {
      userId: user.id,
      staffRoles: roles,
      memberships: [],
      activeOrganizationId: null,
      isPartner: false,
      mfaVerified: options.mfaVerified ?? true,
      impersonation: null,
      flags: {},
    },
    ctx: { userId: user.id, organizationId: null, staff: roles.length > 0, correlationId: 'test' },
    profile: null,
    featureFlags: {},
  };
}

export async function insertStaffUser(
  owner: Database,
  user: { id: string; name: string; email: string },
  roles: StaffRole[],
): Promise<void> {
  await owner.insert(schema.user).values({ id: user.id, name: user.name, email: user.email });
  if (roles.length > 0) {
    await owner
      .insert(schema.staffRoles)
      .values(roles.map((role) => ({ userId: user.id, role, reason: 'integration test' })));
  }
}

export function contextFor(db: Database, identity: RequestIdentity): AdminContext {
  return { db, identity, correlationId: 'test' };
}

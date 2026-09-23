import { schema, type Database } from '@simplexd/db';
import { uniqueSuffix } from '@simplexd/db/testing';
import type { Actor, OrgRole, StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Fixtures for the project delivery integration tests. Rows are inserted
 * with the owner role; services run against the runtime role through
 * synthetic RequestIdentity objects (getIdentity() is never called).
 */

export interface FixtureUser {
  id: string;
  name: string;
}

export interface ProjectFixtures {
  orgA: string;
  orgB: string;
  ownerA: FixtureUser;
  approverA: FixtureUser;
  memberA: FixtureUser;
  adviserA: FixtureUser;
  ownerB: FixtureUser;
  superAdmin: FixtureUser;
  ops: FixtureUser;
  pm: FixtureUser;
  pm2: FixtureUser;
  inspector: FixtureUser;
  inspector2: FixtureUser;
  finance: FixtureUser;
  partner: FixtureUser;
  fileClean: string;
  fileClean2: string;
  fileScanning: string;
  fileInfected: string;
  fileOrgB: string;
}

export async function createFixtures(owner: Database): Promise<ProjectFixtures> {
  const sfx = uniqueSuffix();
  const mk = (label: string): FixtureUser => ({ id: `u_${label}_${sfx}`, name: label });
  const users = {
    ownerA: mk('ownerA'),
    approverA: mk('approverA'),
    memberA: mk('memberA'),
    adviserA: mk('adviserA'),
    ownerB: mk('ownerB'),
    superAdmin: mk('superAdmin'),
    ops: mk('ops'),
    pm: mk('pm'),
    pm2: mk('pm2'),
    inspector: mk('inspector'),
    inspector2: mk('inspector2'),
    finance: mk('finance'),
    partner: mk('partner'),
  };
  const orgA = `org_a_${sfx}`;
  const orgB = `org_b_${sfx}`;
  await owner
    .insert(schema.user)
    .values(
      Object.values(users).map((u) => ({ id: u.id, name: u.name, email: `${u.id}@example.test` })),
    );
  await owner.insert(schema.organization).values([
    { id: orgA, name: 'Org A', slug: orgA },
    { id: orgB, name: 'Org B', slug: orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${users.ownerA.id}`, organizationId: orgA, userId: users.ownerA.id, role: 'owner' },
    {
      id: `m_${users.approverA.id}`,
      organizationId: orgA,
      userId: users.approverA.id,
      role: 'approver',
    },
    { id: `m_${users.memberA.id}`, organizationId: orgA, userId: users.memberA.id, role: 'member' },
    {
      id: `m_${users.adviserA.id}`,
      organizationId: orgA,
      userId: users.adviserA.id,
      role: 'adviser',
    },
    { id: `m_${users.ownerB.id}`, organizationId: orgB, userId: users.ownerB.id, role: 'owner' },
  ]);
  const roles: Array<[FixtureUser, StaffRole]> = [
    [users.superAdmin, 'super_admin'],
    [users.ops, 'operations_manager'],
    [users.pm, 'project_manager'],
    [users.pm2, 'project_manager'],
    [users.inspector, 'inspector'],
    [users.inspector2, 'inspector'],
    [users.finance, 'finance'],
  ];
  await owner.insert(schema.staffRoles).values(roles.map(([u, role]) => ({ userId: u.id, role })));
  await owner.insert(schema.partnerProfiles).values({
    userId: users.partner.id,
    partnerType: 'contractor',
    displayName: 'Partner Co',
    verificationStatus: 'verified',
  });
  const files = await owner
    .insert(schema.fileObjects)
    .values([
      file(orgA, users.inspector.id, 'clean', `clean1-${sfx}`),
      file(orgA, users.inspector.id, 'clean', `clean2-${sfx}`),
      file(orgA, users.inspector.id, 'scanning', `scanning-${sfx}`),
      file(orgA, users.inspector.id, 'infected', `infected-${sfx}`),
      file(orgB, users.ownerB.id, 'clean', `orgb-${sfx}`),
    ])
    .returning({ id: schema.fileObjects.id, storageKey: schema.fileObjects.storageKey });
  const byKey = (prefix: string) => files.find((f) => f.storageKey.startsWith(`${prefix}-`))!.id;
  return {
    orgA,
    orgB,
    ...users,
    fileClean: byKey('clean1'),
    fileClean2: byKey('clean2'),
    fileScanning: byKey('scanning'),
    fileInfected: byKey('infected'),
    fileOrgB: byKey('orgb'),
  };
}

function file(
  orgId: string,
  ownerUserId: string,
  status: 'clean' | 'scanning' | 'infected',
  key: string,
) {
  return {
    organizationId: orgId,
    ownerUserId,
    bucket: status === 'clean' ? ('private' as const) : ('quarantine' as const),
    storageKey: key,
    originalName: `${key}.jpg`,
    declaredMime: 'image/jpeg',
    detectedMime: 'image/jpeg',
    sizeBytes: 1234,
    checksumSha256: status === 'scanning' ? null : `sha-${key}`,
    status,
    purpose: 'evidence',
  };
}

export interface IdentityOptions {
  staffRoles?: StaffRole[];
  memberships?: Array<{ organizationId: string; role: OrgRole }>;
  activeOrganizationId?: string | null;
  isPartner?: boolean;
  mfaVerified?: boolean;
}

/** Builds a RequestIdentity the way lib/auth/session.ts would for a signed-in user. */
export function identityFor(user: FixtureUser, options: IdentityOptions = {}): RequestIdentity {
  const staffRoles = options.staffRoles ?? [];
  const memberships = options.memberships ?? [];
  const activeOrganizationId =
    options.activeOrganizationId ?? memberships[0]?.organizationId ?? null;
  const actor: Actor = {
    userId: user.id,
    staffRoles,
    memberships,
    activeOrganizationId,
    isPartner: options.isPartner ?? false,
    mfaVerified: options.mfaVerified ?? false,
    impersonation: null,
    flags: {},
  };
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
      activeOrganizationId,
    },
    user: {
      id: user.id,
      name: user.name,
      email: `${user.id}@example.test`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  } as unknown as NonNullable<RequestIdentity['session']>;
  return {
    session,
    actor,
    ctx: {
      userId: user.id,
      organizationId: activeOrganizationId,
      staff: staffRoles.length > 0,
      anonymousToken: null,
    },
    profile: null,
    featureFlags: {},
  };
}

export function customerIdentity(
  f: ProjectFixtures,
  user: FixtureUser,
  role: OrgRole,
  orgId = f.orgA,
): RequestIdentity {
  return identityFor(user, {
    memberships: [{ organizationId: orgId, role }],
    activeOrganizationId: orgId,
  });
}

export function staffIdentity(
  user: FixtureUser,
  role: StaffRole,
  mfaVerified = false,
): RequestIdentity {
  return identityFor(user, { staffRoles: [role], mfaVerified });
}

export function partnerIdentity(user: FixtureUser): RequestIdentity {
  return identityFor(user, { isPartner: true });
}

/** Extracts the stable error code from an ApiError or AuthorizationError. */
export async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as {
      code?: string;
      decision?: { code: string };
      name?: string;
      message?: string;
    };
    if (e.name === 'AuthorizationError') return `forbidden:${e.decision?.code ?? ''}`;
    return e.code ?? `error:${e.message ?? ''}`;
  }
}

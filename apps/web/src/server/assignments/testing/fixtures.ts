import { schema, type Database } from '@simplexd/db';
import {
  connectTestDatabases,
  resetDatabase,
  uniqueSuffix,
  type TestDatabases,
} from '@simplexd/db/testing';
import type { OrgRole, StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Integration fixtures for the collaboration modules: two customer
 * organisations, their owners, a staff operations manager, a project manager,
 * a support agent, a partner, one service request and one project per
 * organisation. Rows are inserted with the owner role; the services under
 * test run through the runtime role, so row-level security applies.
 */

export interface Fixture {
  dbs: TestDatabases;
  orgA: string;
  orgB: string;
  ownerA: string;
  ownerB: string;
  adviserA: string;
  ops: string;
  pm: string;
  support: string;
  partner: string;
  serviceId: string;
  serviceRequestA: string;
  serviceRequestB: string;
  projectA: string;
  projectB: string;
}

export interface IdentityOptions {
  staffRoles?: StaffRole[];
  memberships?: Array<{ organizationId: string; role: OrgRole }>;
  activeOrganizationId?: string | null;
  isPartner?: boolean;
}

/** A synthetic request identity, shaped like the one lib/auth/session.ts resolves. */
export function identityFor(userId: string, opts: IdentityOptions = {}): RequestIdentity {
  const memberships = opts.memberships ?? [];
  const activeOrganizationId =
    opts.activeOrganizationId === undefined
      ? (memberships[0]?.organizationId ?? null)
      : opts.activeOrganizationId;
  const staffRoles = opts.staffRoles ?? [];
  const now = new Date();
  const session = {
    user: {
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `sess_${userId}`,
      userId,
      token: `tok_${userId}`,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      activeOrganizationId,
    },
  } as unknown as RequestIdentity['session'];
  return {
    session,
    actor: {
      userId,
      staffRoles,
      memberships,
      activeOrganizationId,
      isPartner: opts.isPartner ?? false,
      mfaVerified: false,
      impersonation: null,
      flags: {},
    },
    ctx: { userId, organizationId: activeOrganizationId, staff: staffRoles.length > 0 },
    profile: null,
    featureFlags: {},
  };
}

export async function createFixture(): Promise<Fixture> {
  const dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  const owner = dbs.owner;
  const s = uniqueSuffix();
  const ids = {
    orgA: `org_a_${s}`,
    orgB: `org_b_${s}`,
    ownerA: `owner_a_${s}`,
    ownerB: `owner_b_${s}`,
    adviserA: `adviser_a_${s}`,
    ops: `ops_${s}`,
    pm: `pm_${s}`,
    support: `support_${s}`,
    partner: `partner_${s}`,
  };
  await owner.insert(schema.user).values(
    Object.entries(ids)
      .filter(([k]) => !k.startsWith('org'))
      .map(([, id]) => ({ id, name: id, email: `${id}@example.test` })),
  );
  await owner.insert(schema.organization).values([
    { id: ids.orgA, name: 'Org A', slug: ids.orgA },
    { id: ids.orgB, name: 'Org B', slug: ids.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.adviserA}`, organizationId: ids.orgA, userId: ids.adviserA, role: 'adviser' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.pm, role: 'project_manager' },
    { userId: ids.support, role: 'support' },
  ]);
  await owner.insert(schema.partnerProfiles).values({
    userId: ids.partner,
    partnerType: 'surveyor',
    displayName: 'Survey Partner',
    verificationStatus: 'verified',
  });
  const [svc] = await owner
    .insert(schema.services)
    .values({
      slug: `svc-${s}`,
      name: 'Due diligence',
      shortDescription: 'test',
      workflowTemplateKey: 'due_diligence',
    })
    .returning({ id: schema.services.id });
  const srs = await owner
    .insert(schema.serviceRequests)
    .values([
      {
        reference: `SR-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: svc!.id,
        title: 'Request A',
      },
      {
        reference: `SR-B-${s}`,
        organizationId: ids.orgB,
        requestedByUserId: ids.ownerB,
        serviceId: svc!.id,
        title: 'Request B',
      },
    ])
    .returning({
      id: schema.serviceRequests.id,
      organizationId: schema.serviceRequests.organizationId,
    });
  const projects = await owner
    .insert(schema.projects)
    .values([
      { organizationId: ids.orgA, name: 'Project A', kind: 'construction_monitoring' },
      { organizationId: ids.orgB, name: 'Project B', kind: 'construction_monitoring' },
    ])
    .returning({ id: schema.projects.id, organizationId: schema.projects.organizationId });
  return {
    dbs,
    ...ids,
    serviceId: svc!.id,
    serviceRequestA: srs.find((r) => r.organizationId === ids.orgA)!.id,
    serviceRequestB: srs.find((r) => r.organizationId === ids.orgB)!.id,
    projectA: projects.find((r) => r.organizationId === ids.orgA)!.id,
    projectB: projects.find((r) => r.organizationId === ids.orgB)!.id,
  };
}

export function customerIdentity(
  f: Fixture,
  which: 'A' | 'B',
  role: OrgRole = 'owner',
): RequestIdentity {
  const userId = which === 'A' ? (role === 'adviser' ? f.adviserA : f.ownerA) : f.ownerB;
  const organizationId = which === 'A' ? f.orgA : f.orgB;
  return identityFor(userId, { memberships: [{ organizationId, role }] });
}

export function opsIdentity(f: Fixture): RequestIdentity {
  return identityFor(f.ops, { staffRoles: ['operations_manager'] });
}

export function pmIdentity(f: Fixture): RequestIdentity {
  return identityFor(f.pm, { staffRoles: ['project_manager'] });
}

export function supportIdentity(f: Fixture): RequestIdentity {
  return identityFor(f.support, { staffRoles: ['support'] });
}

export function partnerIdentity(f: Fixture): RequestIdentity {
  return identityFor(f.partner, { isPartner: true });
}

/** A clean file in an organisation's store (owner role). */
export async function insertFile(
  owner: Database,
  organizationId: string,
  ownerUserId: string,
  status: (typeof schema.fileStatusEnum.enumValues)[number] = 'clean',
): Promise<string> {
  const [row] = await owner
    .insert(schema.fileObjects)
    .values({
      organizationId,
      ownerUserId,
      bucket: status === 'clean' ? 'private' : 'quarantine',
      storageKey: `test/${uniqueSuffix()}`,
      originalName: 'authority.pdf',
      declaredMime: 'application/pdf',
      status,
      purpose: 'owner_authority',
    })
    .returning({ id: schema.fileObjects.id });
  return row!.id;
}

/** A property inserted with the owner role (the runtime role cannot insert properties yet, see properties/service.ts). */
export async function insertProperty(
  owner: Database,
  organizationId: string,
  values: Partial<typeof schema.properties.$inferInsert> = {},
): Promise<string> {
  const [row] = await owner
    .insert(schema.properties)
    .values({
      organizationId,
      name: values.name ?? `Property ${uniqueSuffix()}`,
      kind: values.kind ?? 'land',
      ...values,
    })
    .returning({ id: schema.properties.id });
  return row!.id;
}

/** Matches an ApiError or AuthorizationError by code. */
export function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; decision?: { code?: string }; name?: string };
  if (e?.name === 'AuthorizationError') return 'forbidden';
  return e?.code;
}

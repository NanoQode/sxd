import { createHash, randomUUID } from 'node:crypto';
import { inArray, or, and, eq } from 'drizzle-orm';
import { schema, type Database } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import type { StaffRole } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { identityFor } from '@/server/assignments/testing/fixtures';

export { errorCode, identityFor } from '@/server/assignments/testing/fixtures';

/**
 * Integration fixtures for engagement records and request reports. The test
 * database is shared with other suites running at the same time, so nothing
 * is truncated: every row is created with unique ids and `cleanupFixture`
 * removes what this fixture created (best effort, leaf tables first).
 *
 * People: two customer organisations (owner + adviser in A, owner in B), an
 * operations manager, two project managers (one assigned to the requests),
 * a staff inspector, a surveyor partner, a legal partner and an unrelated
 * partner. Requests: a due-diligence request per organisation and a virtual
 * inspection request in organisation A.
 */

export interface EngagementFixture {
  dbs: TestDatabases;
  suffix: string;
  orgA: string;
  orgB: string;
  ownerA: string;
  adviserA: string;
  ownerB: string;
  ops: string;
  pm: string;
  otherPm: string;
  inspector: string;
  surveyor: string;
  legal: string;
  outsider: string;
  diligenceServiceId: string;
  inspectionServiceId: string;
  requestA: string;
  requestB: string;
  inspectionRequest: string;
  userIds: string[];
  fileIds: string[];
}

export async function createEngagementFixture(): Promise<EngagementFixture> {
  const dbs = connectTestDatabases();
  const owner = dbs.owner;
  const s = uniqueSuffix();
  const ids = {
    orgA: `eng_org_a_${s}`,
    orgB: `eng_org_b_${s}`,
    ownerA: `eng_owner_a_${s}`,
    adviserA: `eng_adviser_a_${s}`,
    ownerB: `eng_owner_b_${s}`,
    ops: `eng_ops_${s}`,
    pm: `eng_pm_${s}`,
    otherPm: `eng_pm2_${s}`,
    inspector: `eng_insp_${s}`,
    surveyor: `eng_surveyor_${s}`,
    legal: `eng_legal_${s}`,
    outsider: `eng_outsider_${s}`,
  };
  const userIds = Object.entries(ids)
    .filter(([k]) => !k.startsWith('org'))
    .map(([, id]) => id);
  await owner
    .insert(schema.user)
    .values(userIds.map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.test` })));
  await owner.insert(schema.organization).values([
    { id: ids.orgA, name: `Buyer A ${s}`, slug: ids.orgA },
    { id: ids.orgB, name: `Buyer B ${s}`, slug: ids.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${ids.ownerA}`, organizationId: ids.orgA, userId: ids.ownerA, role: 'owner' },
    { id: `m_${ids.adviserA}`, organizationId: ids.orgA, userId: ids.adviserA, role: 'adviser' },
    { id: `m_${ids.ownerB}`, organizationId: ids.orgB, userId: ids.ownerB, role: 'owner' },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: ids.ops, role: 'operations_manager' },
    { userId: ids.pm, role: 'project_manager' },
    { userId: ids.otherPm, role: 'project_manager' },
    { userId: ids.inspector, role: 'inspector' },
  ]);
  await owner.insert(schema.partnerProfiles).values([
    {
      userId: ids.surveyor,
      partnerType: 'surveyor',
      displayName: 'Survey Partner',
      verificationStatus: 'verified',
    },
    {
      userId: ids.legal,
      partnerType: 'legal',
      displayName: 'Legal Partner',
      verificationStatus: 'verified',
    },
    {
      userId: ids.outsider,
      partnerType: 'surveyor',
      displayName: 'Unrelated Partner',
      verificationStatus: 'verified',
    },
  ]);
  const services = await owner
    .insert(schema.services)
    .values([
      {
        slug: `dd-${s}`,
        name: 'Due diligence',
        shortDescription: 'test',
        workflowTemplateKey: 'due_diligence',
      },
      {
        slug: `vi-${s}`,
        name: 'Virtual inspection',
        shortDescription: 'test',
        workflowTemplateKey: 'virtual_inspection',
      },
    ])
    .returning({ id: schema.services.id, key: schema.services.workflowTemplateKey });
  const dd = services.find((x) => x.key === 'due_diligence')!.id;
  const vi = services.find((x) => x.key === 'virtual_inspection')!.id;
  const srs = await owner
    .insert(schema.serviceRequests)
    .values([
      {
        reference: `SR-DD-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: dd,
        title: 'Plot 12 diligence',
        status: 'in_progress',
        assignedPmUserId: ids.pm,
      },
      {
        reference: `SR-DD-B-${s}`,
        organizationId: ids.orgB,
        requestedByUserId: ids.ownerB,
        serviceId: dd,
        title: 'Other buyer diligence',
        status: 'in_progress',
        assignedPmUserId: ids.otherPm,
      },
      {
        reference: `SR-VI-A-${s}`,
        organizationId: ids.orgA,
        requestedByUserId: ids.ownerA,
        serviceId: vi,
        title: 'Duplex virtual inspection',
        status: 'in_progress',
        assignedPmUserId: ids.pm,
      },
    ])
    .returning({ id: schema.serviceRequests.id, reference: schema.serviceRequests.reference });
  return {
    dbs,
    suffix: s,
    ...ids,
    diligenceServiceId: dd,
    inspectionServiceId: vi,
    requestA: srs.find((r) => r.reference === `SR-DD-A-${s}`)!.id,
    requestB: srs.find((r) => r.reference === `SR-DD-B-${s}`)!.id,
    inspectionRequest: srs.find((r) => r.reference === `SR-VI-A-${s}`)!.id,
    userIds,
    fileIds: [],
  };
}

export function customer(f: EngagementFixture, which: 'A' | 'B' | 'adviserA'): RequestIdentity {
  if (which === 'B')
    return identityFor(f.ownerB, { memberships: [{ organizationId: f.orgB, role: 'owner' }] });
  if (which === 'adviserA')
    return identityFor(f.adviserA, { memberships: [{ organizationId: f.orgA, role: 'adviser' }] });
  return identityFor(f.ownerA, { memberships: [{ organizationId: f.orgA, role: 'owner' }] });
}

export function staff(userId: string, role: StaffRole): RequestIdentity {
  return identityFor(userId, { staffRoles: [role] });
}

export function partner(userId: string): RequestIdentity {
  return identityFor(userId, { isPartner: true });
}

/** A clean, scanned file row (owner role) as if uploaded through the pipeline. */
export async function insertCleanFile(
  f: EngagementFixture,
  input: {
    ownerUserId: string;
    organizationId: string | null;
    purpose?: string;
    name?: string;
    entity?: { type: string; id: string } | null;
    mime?: string;
  },
): Promise<string> {
  const content = `${input.name ?? 'file'}-${randomUUID()}`;
  const [row] = await f.dbs.owner
    .insert(schema.fileObjects)
    .values({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      bucket: 'private',
      storageKey: `test/engagements/${uniqueSuffix()}-${randomUUID()}`,
      originalName: input.name ?? 'document.pdf',
      declaredMime: input.mime ?? 'application/pdf',
      sizeBytes: content.length,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      status: 'clean',
      purpose: input.purpose ?? 'evidence',
      entityType: input.entity?.type ?? null,
      entityId: input.entity?.id ?? null,
    })
    .returning({ id: schema.fileObjects.id });
  f.fileIds.push(row!.id);
  return row!.id;
}

/** An active report template of a kind with a unique name. */
export async function insertTemplate(
  owner: Database,
  kind: 'diligence_memo' | 'virtual_inspection',
  suffix: string,
  sections: Array<{ key: string; heading: string; guidance?: string; required: boolean }>,
  limitationsMarkdown: string | null,
): Promise<string> {
  const [row] = await owner
    .insert(schema.reportTemplates)
    .values({ kind, name: `Test ${kind} ${suffix}`, sections, limitationsMarkdown, active: true })
    .returning({ id: schema.reportTemplates.id });
  return row!.id;
}

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Best effort: rows another table still references are left in place.
  }
}

/** Removes what the fixture created (leaf tables first); failures are ignored. */
export async function cleanupFixture(f: EngagementFixture, templateIds: string[] = []) {
  const o = f.dbs.owner;
  const orgs = [f.orgA, f.orgB];
  const srs = [f.requestA, f.requestB, f.inspectionRequest];
  const reports = (
    await o
      .select({ id: schema.reports.id })
      .from(schema.reports)
      .where(inArray(schema.reports.organizationId, orgs))
  ).map((r) => r.id);
  const items = (
    await o
      .select({ id: schema.engagementItems.id })
      .from(schema.engagementItems)
      .where(inArray(schema.engagementItems.serviceRequestId, srs))
  ).map((r) => r.id);
  if (items.length > 0)
    await attempt(() =>
      o
        .delete(schema.notes)
        .where(
          and(
            eq(schema.notes.entityType, 'engagement_item'),
            inArray(schema.notes.entityId, items),
          ),
        ),
    );
  await attempt(() =>
    o.delete(schema.engagementItems).where(inArray(schema.engagementItems.serviceRequestId, srs)),
  );
  await attempt(() =>
    o.delete(schema.evidence).where(inArray(schema.evidence.organizationId, orgs)),
  );
  if (reports.length > 0) {
    await attempt(() =>
      o.delete(schema.reportRevisions).where(inArray(schema.reportRevisions.reportId, reports)),
    );
    await attempt(() => o.delete(schema.reports).where(inArray(schema.reports.id, reports)));
  }
  if (templateIds.length > 0)
    await attempt(() =>
      o.delete(schema.reportTemplates).where(inArray(schema.reportTemplates.id, templateIds)),
    );
  await attempt(() =>
    o.delete(schema.appointments).where(inArray(schema.appointments.organizationId, orgs)),
  );
  if (f.fileIds.length > 0) {
    await attempt(() =>
      o.delete(schema.fileAccessGrants).where(inArray(schema.fileAccessGrants.fileId, f.fileIds)),
    );
    await attempt(() =>
      o.delete(schema.fileObjects).where(inArray(schema.fileObjects.id, f.fileIds)),
    );
  }
  await attempt(() =>
    o
      .delete(schema.assignments)
      .where(
        or(
          inArray(schema.assignments.serviceRequestId, srs),
          inArray(schema.assignments.organizationId, orgs),
        ),
      ),
  );
}

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@simplexd/contracts';
import { schema, withActor } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { customerIdentity } from '@/testing/identity';
import { createServiceRequest } from './create';
import { getServiceRequestDetail, listServiceRequests } from './queries';
import { applyCustomerTransition } from './transition';

/**
 * Customer intake and transitions against the real database with row-level
 * security: reference uniqueness under concurrency, cancel-with-reason via the
 * engagement machine, optimistic concurrency, and cross-organisation isolation
 * using two organisations and their own RLS contexts.
 */

let dbs: TestDatabases;
const sfx = uniqueSuffix();
const ids = {
  userA: `req_user_a_${sfx}`,
  userB: `req_user_b_${sfx}`,
  orgA: `req_org_a_${sfx}`,
  orgB: `req_org_b_${sfx}`,
};
let bookableSlug: string;
let expansionSlug: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  const owner = dbs.owner;
  await owner.insert(schema.user).values([
    { id: ids.userA, name: 'Ada A', email: `${ids.userA}@example.test` },
    { id: ids.userB, name: 'Bola B', email: `${ids.userB}@example.test` },
  ]);
  await owner.insert(schema.organization).values([
    { id: ids.orgA, name: 'Org A', slug: ids.orgA },
    { id: ids.orgB, name: 'Org B', slug: ids.orgB },
  ]);
  await owner.insert(schema.member).values([
    { id: `m_${ids.userA}`, organizationId: ids.orgA, userId: ids.userA, role: 'owner' },
    { id: `m_${ids.userB}`, organizationId: ids.orgB, userId: ids.userB, role: 'owner' },
  ]);
  bookableSlug = `dd-${sfx}`;
  expansionSlug = `exp-${sfx}`;
  await owner.insert(schema.services).values([
    {
      slug: bookableSlug,
      name: 'Due diligence (test)',
      category: 'core',
      shortDescription: 'test',
      workflowTemplateKey: 'due_diligence',
      bookingEnabled: true,
      publicationState: 'published',
    },
    {
      slug: expansionSlug,
      name: 'Expansion (test)',
      category: 'expansion',
      shortDescription: 'test',
      workflowTemplateKey: 'snagging',
      featureFlagKey: `expansion.snagging.${sfx}`,
      bookingEnabled: false,
      publicationState: 'draft',
    },
  ]);
});

afterAll(async () => {
  await dbs.close();
});

const identityA = () =>
  customerIdentity({
    userId: ids.userA,
    email: `${ids.userA}@example.test`,
    organizationId: ids.orgA,
    role: 'owner',
  });
const identityB = () =>
  customerIdentity({
    userId: ids.userB,
    email: `${ids.userB}@example.test`,
    organizationId: ids.orgB,
    role: 'owner',
  });

describe('service request creation', () => {
  it('creates a request in inquiry with a sequential reference, transition, outbox event and audit entry', async () => {
    const created = await createServiceRequest(
      {
        serviceSlug: bookableSlug,
        description: 'Please check the title documents for a plot in Lekki.',
        intake: {
          property: 'Plot 12, Lekki Phase 1',
          title_documents: 'C of O',
          unknown_key: 'ignored',
        },
        preferredTimeline: 'within_3_months',
        budgetNaira: 2_500_000,
      },
      identityA(),
      { correlationId: `corr-${sfx}` },
    );
    expect(created.reference).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(created.status).toBe('inquiry');
    expect(created.intake).toEqual({
      property: 'Plot 12, Lekki Phase 1',
      title_documents: 'C of O',
    });
    expect(created.budgetNaira).toBe(2_500_000);
    expect(created.title).toBe('Due diligence (test)');

    const transitions = await dbs.owner
      .select()
      .from(schema.engagementTransitions)
      .where(eq(schema.engagementTransitions.serviceRequestId, created.id));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'inquiry',
      actorType: 'customer',
      actorUserId: ids.userA,
    });

    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateId, created.id),
          eq(schema.outboxEvents.eventType, 'service_request.transitioned'),
        ),
      );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.organizationId).toBe(ids.orgA);

    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, created.id),
          eq(schema.auditEvents.action, 'service_request.created'),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(ids.userA);
  });

  it('allocates unique references under concurrent creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createServiceRequest(
          {
            serviceSlug: bookableSlug,
            description: `Concurrent request number ${i} for uniqueness.`,
            intake: {},
          },
          identityA(),
          { correlationId: `corr-${sfx}-${i}` },
        ),
      ),
    );
    const references = results.map((r) => r.reference);
    expect(new Set(references).size).toBe(references.length);
    const sequences = references.map((r) => Number(r.slice(-6)));
    expect(Math.max(...sequences) - Math.min(...sequences)).toBeGreaterThanOrEqual(5);
  });

  it('refuses a service that is not bookable and points to the interest path', async () => {
    await expect(
      createServiceRequest(
        {
          serviceSlug: expansionSlug,
          description: 'Interested in snagging for a handover.',
          intake: {},
        },
        identityA(),
        { correlationId: `corr-${sfx}-nb` },
      ),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });

  it('requires an active organisation', async () => {
    const noOrg = customerIdentity({
      userId: ids.userA,
      email: `${ids.userA}@example.test`,
      organizationId: null,
      memberships: [],
    });
    await expect(
      createServiceRequest(
        {
          serviceSlug: bookableSlug,
          description: 'No organisation yet on this account.',
          intake: {},
        },
        noOrg,
        {
          correlationId: 'x',
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('customer transitions', () => {
  it('cancels only with a reason, bumps the version and records the transition', async () => {
    const created = await createServiceRequest(
      {
        serviceSlug: bookableSlug,
        description: 'A request that will be cancelled by the customer.',
        intake: {},
      },
      identityA(),
      { correlationId: `corr-${sfx}-cancel` },
    );
    await expect(
      applyCustomerTransition(
        identityA(),
        created.id,
        { to: 'cancelled', expectedVersion: created.version },
        { correlationId: 'c1' },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === 'invalid_transition' &&
        (err.details as { code: string }).code === 'reason_required',
    );

    const cancelled = await applyCustomerTransition(
      identityA(),
      created.id,
      { to: 'cancelled', reason: 'Bought elsewhere', expectedVersion: created.version },
      { correlationId: 'c2' },
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Bought elsewhere');
    expect(cancelled.version).toBe(created.version + 1);

    const detail = await getServiceRequestDetail(identityA(), created.id);
    expect(detail.transitions.map((t) => t.toStatus)).toEqual(['inquiry', 'cancelled']);
    expect(detail.transitions[1]!.reason).toBe('Bought elsewhere');
    expect(detail.availableTransitions).toEqual([]);

    // Terminal state: no further transitions.
    await expect(
      applyCustomerTransition(
        identityA(),
        created.id,
        { to: 'paused', reason: 'x', expectedVersion: cancelled.version },
        { correlationId: 'c3' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('rejects a stale expectedVersion', async () => {
    const created = await createServiceRequest(
      {
        serviceSlug: bookableSlug,
        description: 'A request used for the version conflict check.',
        intake: {},
      },
      identityA(),
      { correlationId: `corr-${sfx}-ver` },
    );
    await expect(
      applyCustomerTransition(
        identityA(),
        created.id,
        { to: 'cancelled', reason: 'stale', expectedVersion: created.version + 5 },
        { correlationId: 'v1' },
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('does not allow a customer to move a request into staff-only states', async () => {
    const created = await createServiceRequest(
      {
        serviceSlug: bookableSlug,
        description: 'A request used for the actor rule check.',
        intake: {},
      },
      identityA(),
      { correlationId: `corr-${sfx}-actor` },
    );
    // inquiry → paused is not a customer transition; the machine refuses it.
    await expect(
      applyCustomerTransition(
        identityA(),
        created.id,
        { to: 'paused', reason: 'wait', expectedVersion: created.version },
        { correlationId: 'a1' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });
});

describe('cross-organisation isolation', () => {
  it('hides organisation A requests from organisation B through RLS and the read models', async () => {
    const created = await createServiceRequest(
      {
        serviceSlug: bookableSlug,
        description: 'Org A private request that B must never see.',
        intake: {},
      },
      identityA(),
      { correlationId: `corr-${sfx}-iso` },
    );
    const rowsForB = await withActor(
      dbs.app,
      { userId: ids.userB, organizationId: ids.orgB, staff: false },
      (tx) =>
        tx
          .select({ id: schema.serviceRequests.id })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.id, created.id)),
    );
    expect(rowsForB).toHaveLength(0);
    const rowsForA = await withActor(
      dbs.app,
      { userId: ids.userA, organizationId: ids.orgA, staff: false },
      (tx) =>
        tx
          .select({ id: schema.serviceRequests.id })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.id, created.id)),
    );
    expect(rowsForA).toHaveLength(1);

    await expect(getServiceRequestDetail(identityB(), created.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      applyCustomerTransition(
        identityB(),
        created.id,
        { to: 'cancelled', reason: 'intruder', expectedVersion: created.version },
        { correlationId: 'i1' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    const listB = await listServiceRequests(identityB(), { limit: 50 });
    expect(listB.items.map((i) => i.id)).not.toContain(created.id);
    const listA = await listServiceRequests(identityA(), { limit: 50 });
    expect(listA.items.map((i) => i.id)).toContain(created.id);
  });

  it('refuses a stale session whose active organisation the user no longer belongs to', async () => {
    // Actor claims org A as active but holds no membership there: the permission model denies.
    const impostor = customerIdentity({
      userId: ids.userB,
      email: `${ids.userB}@example.test`,
      organizationId: ids.orgA,
      memberships: [{ organizationId: ids.orgB, role: 'owner' }],
    });
    await expect(
      createServiceRequest(
        {
          serviceSlug: bookableSlug,
          description: 'Should be denied by membership check.',
          intake: {},
        },
        impostor,
        { correlationId: 'imp' },
      ),
    ).rejects.toMatchObject({ name: 'AuthorizationError' });
  });
});

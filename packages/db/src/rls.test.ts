import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from './schema';
import { withActor } from './tenant';
import { connectTestDatabases, resetDatabase, uniqueSuffix, type TestDatabases } from './testing';

/**
 * Tenant isolation at the database layer. The runtime role connects without
 * BYPASSRLS, so these tests prove that:
 *  - an organisation cannot read another organisation's rows,
 *  - a query without an actor context returns nothing (default deny),
 *  - staff/system contexts can see everything,
 *  - append-only tables reject updates and deletes,
 *  - journals must balance,
 *  - overlapping slot reservations are rejected.
 */

let dbs: TestDatabases;

/** Drizzle wraps driver errors ("Failed query: ...") with the PostgreSQL error as `cause`. */
async function expectDbFailure(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(p).rejects.toSatisfy((err: unknown) => {
    const e = err as { message?: string; cause?: { message?: string } };
    const combined = `${e.message ?? ''}\n${e.cause?.message ?? ''}`;
    return pattern.test(combined);
  });
}

const ids = {
  userA: `user_a_${uniqueSuffix()}`,
  userB: `user_b_${uniqueSuffix()}`,
  staff: `user_staff_${uniqueSuffix()}`,
  orgA: `org_a_${uniqueSuffix()}`,
  orgB: `org_b_${uniqueSuffix()}`,
};
let serviceId: string;
let propertyA: string;
let propertyB: string;

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  const owner = dbs.owner;
  await owner.insert(s.user).values([
    { id: ids.userA, name: 'A', email: `${ids.userA}@example.test` },
    { id: ids.userB, name: 'B', email: `${ids.userB}@example.test` },
    { id: ids.staff, name: 'Staff', email: `${ids.staff}@example.test` },
  ]);
  await owner.insert(s.organization).values([
    { id: ids.orgA, name: 'Org A', slug: ids.orgA },
    { id: ids.orgB, name: 'Org B', slug: ids.orgB },
  ]);
  await owner.insert(s.member).values([
    { id: `m_${ids.userA}`, organizationId: ids.orgA, userId: ids.userA, role: 'owner' },
    { id: `m_${ids.userB}`, organizationId: ids.orgB, userId: ids.userB, role: 'owner' },
  ]);
  const [svc] = await owner
    .insert(s.services)
    .values({
      slug: `svc-${uniqueSuffix()}`,
      name: 'Due diligence',
      shortDescription: 'test',
      workflowTemplateKey: 'due_diligence',
    })
    .returning({ id: s.services.id });
  serviceId = svc!.id;
  const props = await owner
    .insert(s.properties)
    .values([
      {
        organizationId: ids.orgA,
        name: 'Property A',
        kind: 'land',
        location: { lon: 3.39, lat: 6.45 },
      },
      { organizationId: ids.orgB, name: 'Property B', kind: 'residential' },
    ])
    .returning({ id: s.properties.id, name: s.properties.name });
  propertyA = props.find((p) => p.name === 'Property A')!.id;
  propertyB = props.find((p) => p.name === 'Property B')!.id;
  await owner.insert(s.serviceRequests).values([
    {
      reference: `SR-A-${uniqueSuffix()}`,
      organizationId: ids.orgA,
      requestedByUserId: ids.userA,
      serviceId,
      title: 'Request A',
    },
    {
      reference: `SR-B-${uniqueSuffix()}`,
      organizationId: ids.orgB,
      requestedByUserId: ids.userB,
      serviceId,
      title: 'Request B',
    },
  ]);
});

afterAll(async () => {
  await dbs.close();
});

describe('runtime role', () => {
  it('cannot bypass row-level security', async () => {
    const res = await dbs.app.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(res.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('organisation isolation', () => {
  it('returns only the active organisation rows for a customer', async () => {
    const rows = await withActor(
      dbs.app,
      { userId: ids.userA, organizationId: ids.orgA, staff: false },
      (tx) => tx.select({ title: s.serviceRequests.title }).from(s.serviceRequests),
    );
    expect(rows.map((r) => r.title)).toEqual(['Request A']);
  });

  it('denies reads of another organisation even with an explicit id filter', async () => {
    const rows = await withActor(
      dbs.app,
      { userId: ids.userA, organizationId: ids.orgA, staff: false },
      (tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('returns nothing when no actor context was set (default deny)', async () => {
    const rows = await dbs.app.select().from(s.serviceRequests);
    expect(rows).toHaveLength(0);
  });

  it('prevents inserting rows into another organisation', async () => {
    await expectDbFailure(
      withActor(dbs.app, { userId: ids.userA, organizationId: ids.orgA, staff: false }, (tx) =>
        tx
          .insert(s.properties)
          .values({ organizationId: ids.orgB, name: 'Intruder', kind: 'land' }),
      ),
      /row-level security/,
    );
  });

  it('lets staff see every organisation', async () => {
    const rows = await withActor(
      dbs.app,
      { userId: ids.staff, organizationId: null, staff: true },
      (tx) => tx.select({ title: s.serviceRequests.title }).from(s.serviceRequests),
    );
    expect(rows.map((r) => r.title).sort()).toEqual(['Request A', 'Request B']);
  });

  it('grants access through explicit resource grants and revokes immediately', async () => {
    const owner = dbs.owner;
    const [grant] = await owner
      .insert(s.resourceGrants)
      .values({ userId: ids.userB, resourceType: 'property', resourceId: propertyA, level: 'view' })
      .returning({ id: s.resourceGrants.id });
    const visible = await withActor(
      dbs.app,
      { userId: ids.userB, organizationId: ids.orgB, staff: false },
      (tx) =>
        tx
          .select({ name: s.properties.name })
          .from(s.properties)
          .where(eq(s.properties.id, propertyA)),
    );
    expect(visible.map((r) => r.name)).toEqual(['Property A']);
    await owner
      .update(s.resourceGrants)
      .set({ revokedAt: new Date() })
      .where(eq(s.resourceGrants.id, grant!.id));
    const afterRevoke = await withActor(
      dbs.app,
      { userId: ids.userB, organizationId: ids.orgB, staff: false },
      (tx) => tx.select().from(s.properties).where(eq(s.properties.id, propertyA)),
    );
    expect(afterRevoke).toHaveLength(0);
  });

  it('reads back geometry points as longitude/latitude', async () => {
    const rows = await withActor(
      dbs.app,
      { userId: ids.userA, organizationId: ids.orgA, staff: false },
      (tx) =>
        tx
          .select({ location: s.properties.location })
          .from(s.properties)
          .where(eq(s.properties.id, propertyA)),
    );
    expect(rows[0]?.location).toEqual({ lon: 3.39, lat: 6.45 });
  });
});

describe('public reference data', () => {
  it('is readable anonymously but not writable', async () => {
    const rows = await withActor(
      dbs.app,
      { userId: null, organizationId: null, staff: false },
      (tx) => tx.select({ id: s.services.id }).from(s.services),
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      withActor(dbs.app, { userId: ids.userA, organizationId: ids.orgA, staff: false }, (tx) =>
        tx.update(s.services).set({ name: 'Hacked' }).where(eq(s.services.id, serviceId)),
      ),
    ).resolves.toBeDefined();
    // The update above matched zero rows because the policy hides them for writes.
    const [svc] = await dbs.owner
      .select({ name: s.services.name })
      .from(s.services)
      .where(eq(s.services.id, serviceId));
    expect(svc?.name).toBe('Due diligence');
  });
});

describe('append-only and ledger protections', () => {
  it('rejects updates and deletes on audit events', async () => {
    const owner = dbs.owner;
    const [evt] = await owner
      .insert(s.auditEvents)
      .values({ actorType: 'system', action: 'test', entityType: 'test' })
      .returning({ id: s.auditEvents.id });
    await expectDbFailure(
      owner.update(s.auditEvents).set({ action: 'x' }).where(eq(s.auditEvents.id, evt!.id)),
      /append-only/,
    );
    await expectDbFailure(
      owner.delete(s.auditEvents).where(eq(s.auditEvents.id, evt!.id)),
      /append-only/,
    );
  });

  it('rejects an unbalanced journal at commit', async () => {
    const owner = dbs.owner;
    const [acct] = await owner
      .insert(s.ledgerAccounts)
      .values({ code: `T${uniqueSuffix()}`, name: 'Test', type: 'asset', normalBalance: 'debit' })
      .returning({ id: s.ledgerAccounts.id });
    await expectDbFailure(
      owner.transaction(async (tx) => {
        const [j] = await tx
          .insert(s.journals)
          .values({
            businessEventRef: `evt-${uniqueSuffix()}`,
            description: 'bad',
            sourceType: 'test',
          })
          .returning({ id: s.journals.id });
        await tx.insert(s.journalLines).values([
          { journalId: j!.id, lineNo: 1, accountId: acct!.id, debitKobo: 100n },
          { journalId: j!.id, lineNo: 2, accountId: acct!.id, creditKobo: 90n },
        ]);
      }),
      /not balanced/,
    );
  });

  it('accepts a balanced journal', async () => {
    const owner = dbs.owner;
    const [acct] = await owner
      .insert(s.ledgerAccounts)
      .values({ code: `T${uniqueSuffix()}`, name: 'Test2', type: 'asset', normalBalance: 'debit' })
      .returning({ id: s.ledgerAccounts.id });
    const ref = `evt-${uniqueSuffix()}`;
    await owner.transaction(async (tx) => {
      const [j] = await tx
        .insert(s.journals)
        .values({ businessEventRef: ref, description: 'ok', sourceType: 'test' })
        .returning({ id: s.journals.id });
      await tx.insert(s.journalLines).values([
        { journalId: j!.id, lineNo: 1, accountId: acct!.id, debitKobo: 100n },
        { journalId: j!.id, lineNo: 2, accountId: acct!.id, creditKobo: 100n },
      ]);
    });
    const [j] = await owner.select().from(s.journals).where(eq(s.journals.businessEventRef, ref));
    expect(j).toBeDefined();
  });
});

describe('slot reservations', () => {
  it('rejects overlapping reservations for the same staff member', async () => {
    const owner = dbs.owner;
    await owner.execute(sql`
      INSERT INTO slot_reservations (staff_user_id, slot, kind)
      VALUES (${ids.staff}, tstzrange('2026-10-01 09:00+00', '2026-10-01 09:30+00', '[)'), 'appointment')
    `);
    await expectDbFailure(
      owner.execute(sql`
        INSERT INTO slot_reservations (staff_user_id, slot, kind)
        VALUES (${ids.staff}, tstzrange('2026-10-01 09:15+00', '2026-10-01 09:45+00', '[)'), 'hold')
      `),
      /slot_reservations_no_overlap/,
    );
    // Adjacent slots are fine.
    await owner.execute(sql`
      INSERT INTO slot_reservations (staff_user_id, slot, kind)
      VALUES (${ids.staff}, tstzrange('2026-10-01 09:30+00', '2026-10-01 10:00+00', '[)'), 'hold')
    `);
  });
});

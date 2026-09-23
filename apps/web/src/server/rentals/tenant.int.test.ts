import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { eq } from 'drizzle-orm';
import {
  createLease,
  getLease,
  inviteParty,
  listParties,
  postLeaseNotice,
  revokeParty,
  transitionLease,
} from './leases';
import { generateOwnerStatement, listOwnerStatements } from './owner-statements';
import { listPayouts } from './payouts';
import { runRentInvoicing } from './jobs';
import { getLeaseBalance, listCharges } from './schedules';
import {
  createMyTicket,
  getMyBalance,
  getMyLease,
  listMyCharges,
  listMyLeases,
  listMyNotices,
  listMyReceipts,
  listMyTickets,
} from './tenant';
import { cancelWorkOrder, createWorkOrder, getWorkOrder } from '@/server/maintenance/work-orders';
import {
  createRentalFixture,
  errorCode,
  opsIdentity,
  ownerIdentity,
  payInvoice,
  tenantIdentity,
  type RentalFixture,
} from './testing/fixtures';

/**
 * Tenant isolation: a tenant sees only their own lease, balances, charges,
 * receipts, tickets and notices; never another tenant's lease, the owner's
 * other records, owner statements or payouts.
 */

let f: RentalFixture;
let leaseA: string;
let leaseB: string;

async function invite(owner: ReturnType<typeof ownerIdentity>, leaseId: string, tenant: 1 | 2) {
  const email = `${tenant === 1 ? f.tenant1 : f.tenant2}@example.test`;
  const party = await inviteParty(owner, leaseId, {
    role: 'tenant',
    name: 'T',
    email,
    expiresInDays: 7,
  });
  // Accept directly at the data layer (the token flow is covered in rentals.int.test.ts).
  await f.dbs.owner
    .update(schema.leaseParties)
    .set({
      userId: tenant === 1 ? f.tenant1 : f.tenant2,
      accessStatus: 'active',
      acceptedAt: new Date(),
      invitationTokenHash: null,
    })
    .where(eq(schema.leaseParties.id, party.id));
  return party.id;
}

beforeAll(async () => {
  f = await createRentalFixture();
  const base = {
    kind: 'residential_monthly' as const,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    rentAmountKobo: '10000000',
    rentPeriod: 'monthly' as const,
    currency: 'NGN',
    depositKobo: '0',
    managementFeeBasis: 'none' as const,
  };
  const a = await createLease(ownerIdentity(f, 'A'), {
    ...base,
    propertyId: f.propertyA,
    unitId: f.unitA1,
  });
  const b = await createLease(ownerIdentity(f, 'B'), {
    ...base,
    propertyId: f.propertyB,
    unitId: f.unitB1,
  });
  leaseA = a.id;
  leaseB = b.id;
  await invite(ownerIdentity(f, 'A'), leaseA, 1);
  await invite(ownerIdentity(f, 'B'), leaseB, 2);
  await transitionLease(ownerIdentity(f, 'A'), leaseA, { to: 'active', expectedVersion: 1 });
  await transitionLease(ownerIdentity(f, 'B'), leaseB, { to: 'active', expectedVersion: 1 });
  await runRentInvoicing(f.dbs.app, { asOf: '2026-01-01', leadDays: 0 });
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

describe('tenant portal isolation', () => {
  it("lists and reads only the tenant's own lease", async () => {
    const t1 = tenantIdentity(f, 1);
    const mine = await listMyLeases(t1);
    expect(mine.map((l) => l.lease.id)).toEqual([leaseA]);
    expect(mine[0]!.property.name).toBe('Lekki Court');
    expect(mine[0]!.unit?.label).toBe('A1');
    expect(mine[0]!.myRole).toBe('tenant');
    // The management fee terms are not part of the tenant view.
    expect('managementFeeBps' in mine[0]!.lease).toBe(false);
    expect((await getMyLease(t1, leaseA)).lease.id).toBe(leaseA);
    await expect(getMyLease(t1, leaseB)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(getMyBalance(t1, leaseB)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(listMyCharges(t1, leaseB)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    // The generic lease endpoints answer the same way: the other lease is not visible at the SQL level.
    await expect(getLease(t1, leaseB)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(getLeaseBalance(t1, leaseB)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    await expect(listCharges(tenantIdentity(f, 2), leaseA)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    // A tenant sees their own party row only.
    const parties = await listParties(t1, leaseA);
    expect(parties).toHaveLength(1);
    expect(parties[0]!.userId).toBe(f.tenant1);
    expect((await getLease(ownerIdentity(f, 'A'), leaseA)).parties.length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('shows balances, charges, receipts and notices for the tenant only', async () => {
    const t1 = tenantIdentity(f, 1);
    const [invoice] = await f.dbs.owner
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.leaseId, leaseA));
    expect(invoice!.customerUserId).toBe(f.tenant1);
    await payInvoice(f, invoice!.id, f.tenant1);
    const balance = await getMyBalance(t1, leaseA);
    expect(balance.paidKobo).toBe('10000000');
    expect(balance.outstandingKobo).toBe((11n * 10_000_000n).toString());
    const charges = await listMyCharges(t1, leaseA);
    expect(charges.find((c) => c.invoiceId === invoice!.id)?.outstandingKobo).toBe('0');
    const receipts = await listMyReceipts(t1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.invoiceId).toBe(invoice!.id);
    expect(await listMyReceipts(tenantIdentity(f, 2))).toHaveLength(0);
    await postLeaseNotice(ownerIdentity(f, 'A'), leaseA, {
      title: 'Inspection',
      body: 'Annual inspection next week.',
    });
    expect((await listMyNotices(t1)).map((n) => n.title)).toEqual(['Inspection']);
    expect(await listMyNotices(tenantIdentity(f, 2))).toHaveLength(0);
  });

  it('keeps maintenance tickets per tenant and never exposes the owner ledger', async () => {
    const t1 = tenantIdentity(f, 1);
    const t2 = tenantIdentity(f, 2);
    const ticket = await createMyTicket(t1, leaseA, {
      title: 'Leaking tap',
      description: 'Kitchen',
      category: 'plumbing',
      priority: 'normal',
    });
    expect(ticket).toMatchObject({
      leaseId: leaseA,
      propertyId: f.propertyA,
      unitId: f.unitA1,
      reportedByUserId: f.tenant1,
      status: 'requested',
    });
    await expect(
      createMyTicket(t1, leaseB, { title: 'x', category: 'other', priority: 'low' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    expect((await listMyTickets(t1)).map((w) => w.id)).toEqual([ticket.id]);
    expect(await listMyTickets(t2)).toHaveLength(0);
    await expect(getWorkOrder(t2, ticket.id)).rejects.toSatisfy(
      (e) => errorCode(e) === 'not_found',
    );
    expect((await getWorkOrder(ownerIdentity(f, 'A'), ticket.id)).id).toBe(ticket.id);
    // A tenant cancels their own ticket, never one the owner raised on the lease.
    const ownerTicket = await createWorkOrder(ownerIdentity(f, 'A'), {
      propertyId: f.propertyA,
      unitId: f.unitA1,
      leaseId: leaseA,
      title: 'Repaint',
      category: 'decoration',
      priority: 'low',
    });
    await expect(
      cancelWorkOrder(t1, ownerTicket.id, { reason: 'not needed', expectedVersion: 1 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const extra = await createMyTicket(t1, leaseA, {
      title: 'Door squeaks',
      category: 'other',
      priority: 'low',
    });
    expect(
      (await cancelWorkOrder(t1, extra.id, { reason: 'fixed it myself', expectedVersion: 1 }))
        .status,
    ).toBe('cancelled');

    // Owner ledger: statements and payouts are out of reach for tenants.
    const statement = await generateOwnerStatement(opsIdentity(f), {
      organizationId: f.orgA,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    });
    expect(statement.id).toBeTruthy();
    expect((await listOwnerStatements(t1, { limit: 10 })).items).toHaveLength(0);
    expect((await listPayouts(t1, { limit: 10 })).items).toHaveLength(0);
    const visible = await f.dbs.app.transaction(async (tx) => {
      const { applyActorContext } = await import('@simplexd/db');
      await applyActorContext(tx, t1.ctx);
      return tx.select({ id: schema.ownerStatements.id }).from(schema.ownerStatements);
    });
    expect(visible).toHaveLength(0);
  });

  it('removes access the moment a party is revoked', async () => {
    const t1 = tenantIdentity(f, 1);
    const party = (await getLease(ownerIdentity(f, 'A'), leaseA)).parties.find(
      (p) => p.userId === f.tenant1,
    )!;
    await revokeParty(ownerIdentity(f, 'A'), leaseA, party.id, { reason: 'left' });
    expect(await listMyLeases(t1)).toHaveLength(0);
    await expect(getMyLease(t1, leaseA)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(getLease(t1, leaseA)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    expect(await listMyTickets(t1)).toHaveLength(0);
  });
});

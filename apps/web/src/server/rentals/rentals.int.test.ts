import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { createAsset } from '@/server/maintenance/assets';
import { createEstate, attachProperty, runServiceCharges } from './estates';
import {
  acceptTenantInvitation,
  createLease,
  getLease,
  inviteParty,
  listLeases,
  postLeaseNotice,
  revokeParty,
  terminateLease,
  transitionLease,
  updateLease,
} from './leases';
import { generateOwnerStatement, getOwnerStatement, issueOwnerStatement, reconcileOwnerStatement } from './owner-statements';
import { firstApprovePayout, proposePayout, secondApprovePayout, settlePayout, submitPayout } from './payouts';
import { getLeaseBalance, listCharges, listSchedule, runRentInvoicing } from './schedules';
import { createStayBooking, transitionStayBooking } from './stays';
import {
  ALL_FLAGS,
  adviserIdentity,
  createRentalFixture,
  enableFlags,
  errorCode,
  financeIdentity,
  identityFor,
  journalLinesByRef,
  ledgerBalanced,
  opsIdentity,
  ownerIdentity,
  payInvoice,
  supportIdentity,
  tenantIdentity,
  type RentalFixture,
} from './testing/fixtures';

/**
 * Acceptance scenario 9 (owner side): lease → schedule → rent invoice
 * collected on the owner's behalf → settled through the finance path →
 * owner statement reconciled to allocations and journals → two-approver
 * payout; plus feature-flag gating of the expansion variants.
 */

let f: RentalFixture;

beforeAll(async () => {
  f = await createRentalFixture();
});

afterAll(async () => {
  await closeDb();
  await f.dbs.close();
});

const RENT = 1_200_000_00n; // ₦1,200,000 per month in kobo

function currentMonth(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, '0');
  return { periodStart: `${y}-${mm}-01`, periodEnd: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

describe('leases and rent', () => {
  let leaseId: string;

  it('creates a lease, invites the tenant and enforces organisation boundaries', async () => {
    const owner = ownerIdentity(f, 'A');
    const lease = await createLease(owner, {
      propertyId: f.propertyA,
      unitId: f.unitA1,
      kind: 'residential_monthly',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      rentAmountKobo: RENT.toString(),
      rentPeriod: 'monthly',
      currency: 'NGN',
      depositKobo: RENT.toString(),
      managementFeeBasis: 'percentage_of_collected',
      managementFeeBps: 1000,
      terms: { dueLeadDays: 0, prorate: true },
    });
    leaseId = lease.id;
    expect(lease.status).toBe('draft');
    expect(lease.organizationId).toBe(f.orgA);
    expect(lease.terms).toMatchObject({ dueLeadDays: 0 });

    // The other owner cannot see it; the adviser reads but cannot manage; support lacks rentals.manage.
    await expect(getLease(ownerIdentity(f, 'B'), leaseId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    expect((await getLease(adviserIdentity(f), leaseId)).id).toBe(leaseId);
    await expect(updateLease(adviserIdentity(f), leaseId, { expectedVersion: 1, noticePeriodDays: 30 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(updateLease(supportIdentity(f), leaseId, { expectedVersion: 1, noticePeriodDays: 30 })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(
      createLease(ownerIdentity(f, 'B'), { propertyId: f.propertyA, kind: 'residential_monthly', startDate: '2026-01-01', rentAmountKobo: '1', rentPeriod: 'monthly', currency: 'NGN', depositKobo: '0', managementFeeBasis: 'none' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'not_found');

    const party = await inviteParty(owner, leaseId, { role: 'tenant', name: 'Tunde Tenant', email: `${f.tenant1}@example.test`, expiresInDays: 7 });
    expect(party.accessStatus).toBe('invited');
    const [outbox] = await f.dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, 'tenant.invited'));
    const payload = outbox!.payload as { invitationLink: string; email: string };
    expect(payload.email).toBe(`${f.tenant1}@example.test`);
    const token = new URL(payload.invitationLink, 'http://x').searchParams.get('token')!;

    // The wrong person cannot redeem; the invited tenant can, once.
    await expect(acceptTenantInvitation(tenantIdentity(f, 2), { token })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const accepted = await acceptTenantInvitation(tenantIdentity(f, 1), { token });
    expect(accepted.accessStatus).toBe('active');
    expect(accepted.userId).toBe(f.tenant1);
    await expect(acceptTenantInvitation(tenantIdentity(f, 1), { token })).rejects.toSatisfy((e) => errorCode(e) === 'not_found');

    // An expired invitation is refused and marked expired.
    const expired = await inviteParty(owner, leaseId, { role: 'occupant', name: 'Late Occupant', email: 'late@example.test', expiresInDays: 1 });
    await f.dbs.owner.update(schema.leaseParties).set({ invitationExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.leaseParties.id, expired.id));
    const [late] = await f.dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, expired.id));
    const lateToken = new URL((late!.payload as { invitationLink: string }).invitationLink, 'http://x').searchParams.get('token')!;
    await expect(acceptTenantInvitation(identityFor('late_user', { email: 'late@example.test' }), { token: lateToken })).rejects.toSatisfy((e) => errorCode(e) === 'conflict');
    const [lateRow] = await f.dbs.owner.select().from(schema.leaseParties).where(eq(schema.leaseParties.id, expired.id));
    expect(lateRow!.accessStatus).toBe('expired');
  });

  it('activates the lease and generates the schedule with rent, service charge and deposit charges', async () => {
    const owner = ownerIdentity(f, 'A');
    const updated = await updateLease(owner, leaseId, { expectedVersion: 1, terms: { serviceChargeKobo: '5000000' } });
    expect(updated.version).toBe(2);
    const active = await transitionLease(owner, leaseId, { to: 'active', expectedVersion: 2 });
    expect(active.status).toBe('active');
    const schedule = await listSchedule(owner, leaseId);
    expect(schedule).toHaveLength(12);
    expect(schedule[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-31', dueDate: '2026-01-01', status: 'scheduled' });
    expect(schedule[0]!.amountKobo).toBe((RENT + 50_000_00n).toString());
    const charges = await listCharges(owner, leaseId);
    expect(charges.filter((c) => c.kind === 'rent')).toHaveLength(12);
    expect(charges.filter((c) => c.kind === 'service_charge')).toHaveLength(12);
    expect(charges.filter((c) => c.kind === 'deposit')).toHaveLength(1);
    // Activation is idempotent for the schedule and the unit is now occupied.
    await expect(transitionLease(owner, leaseId, { to: 'active', expectedVersion: 3 })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    const [unit] = await f.dbs.owner.select().from(schema.units).where(eq(schema.units.id, f.unitA1));
    expect(unit!.status).toBe('occupied');
    // Rent terms are frozen once active.
    await expect(updateLease(owner, leaseId, { expectedVersion: 3, rentAmountKobo: '1' })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
  });

  it('issues rent invoices on the owner\'s behalf, settles them through finance and mirrors the allocation', async () => {
    const run = await runRentInvoicing(f.dbs.app, { asOf: '2026-01-01', leadDays: 14, now: new Date('2026-01-01T09:00:00Z') });
    expect(run.invoiced).toBe(2); // deposit + January rent
    const invoices = await f.dbs.owner.select().from(schema.invoices).where(eq(schema.invoices.leaseId, leaseId));
    const rent = invoices.find((i) => i.kind === 'rent')!;
    const deposit = invoices.find((i) => i.kind === 'deposit')!;
    expect(rent.status).toBe('issued');
    expect(rent.isRentOnBehalfOfOwner).toBe(true);
    expect(rent.organizationId).toBe(f.orgA); // the owner organisation is the invoice organisation
    expect(rent.customerUserId).toBe(f.tenant1);
    expect(rent.totalKobo).toBe(RENT + 50_000_00n);
    expect(deposit.isRentOnBehalfOfOwner).toBe(false);
    const issuedLines = await journalLinesByRef(f.dbs.owner, `invoice:${rent.id}:issued`);
    expect(issuedLines.map((l) => l.code).sort()).toEqual(['1300', '2100']);
    // Re-running the job never duplicates invoices.
    const again = await runRentInvoicing(f.dbs.app, { asOf: '2026-01-01', leadDays: 14 });
    expect(again.invoiced).toBe(0);
    const schedule = await listSchedule(ownerIdentity(f, 'A'), leaseId);
    expect(schedule[0]!.status).toBe('invoiced');
    expect(schedule[1]!.status).toBe('scheduled');

    const paid = await payInvoice(f, rent.id, f.tenant1);
    expect(paid.allocationId).not.toBeNull();
    expect(paid.receiptNumber).toMatch(/^RCT|^REC|\d/);
    const balance = await getLeaseBalance(ownerIdentity(f, 'A'), leaseId);
    expect(balance.paidKobo).toBe((RENT + 50_000_00n).toString());
    const mirrored = await f.dbs.owner.select().from(schema.rentAllocations).where(eq(schema.rentAllocations.leaseId, leaseId));
    expect(mirrored.reduce((s, r) => s + r.amountKobo, 0n)).toBe(RENT + 50_000_00n);
    expect(mirrored.every((r) => r.allocationId === paid.allocationId)).toBe(true);
    const scheduleAfter = await listSchedule(ownerIdentity(f, 'A'), leaseId);
    expect(scheduleAfter[0]!.status).toBe('paid');
    // Arrears: eleven unpaid periods; the deposit is held, not owed rent; buckets add up to the total.
    expect(balance.arrears.totalOutstandingKobo).toBe((11n * (RENT + 50_000_00n)).toString());
    expect(Object.values(balance.arrears.buckets).reduce((s, v) => s + BigInt(v), 0n).toString()).toBe(balance.arrears.totalOutstandingKobo);
  });

  it('builds an owner statement reconciled to allocations and journals, then pays out with two approvers', async () => {
    const ops = opsIdentity(f);
    // Settlement happened "now", so the statement period is the current month.
    const statement = await generateOwnerStatement(ops, { organizationId: f.orgA, propertyId: f.propertyA, ...currentMonth() });
    expect(statement.status).toBe('draft');
    expect(statement.totals.collectedKobo).toBe((RENT + 50_000_00n).toString());
    expect(statement.totals.feesKobo).toBe((RENT / 10n).toString()); // 1000 bps of rent, not of the service charge
    expect(statement.totals.expensesKobo).toBe('0');
    expect(statement.totals.netKobo).toBe((RENT + 50_000_00n - RENT / 10n).toString());
    expect(statement.lines.filter((l) => l.kind === 'rent_collected')).toHaveLength(1);
    expect(statement.lines.filter((l) => l.kind === 'service_charge_collected')).toHaveLength(1);
    // Owners do not see drafts; support cannot generate.
    await expect(getOwnerStatement(ownerIdentity(f, 'A'), statement.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    await expect(generateOwnerStatement(supportIdentity(f), { organizationId: f.orgA, ...currentMonth() })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');

    const reconciled = await reconcileOwnerStatement(ops, statement.id);
    expect(reconciled.status).toBe('reconciled');
    expect(reconciled.reconciliation).toEqual({
      allocationsKobo: (RENT + 50_000_00n).toString(),
      feeJournalKobo: (RENT / 10n).toString(),
      recoveryJournalKobo: '0',
      matches: true,
    });
    const feeLines = await journalLinesByRef(f.dbs.owner, `owner_statement:${statement.id}:management_fee:${leaseId}`);
    expect(feeLines).toEqual([
      { code: '2100', debitKobo: RENT / 10n, creditKobo: 0n },
      { code: '4100', debitKobo: 0n, creditKobo: RENT / 10n },
    ]);
    const issued = await issueOwnerStatement(ops, statement.id);
    expect(issued.status).toBe('issued');
    expect((await getOwnerStatement(ownerIdentity(f, 'A'), statement.id)).status).toBe('issued');
    await expect(getOwnerStatement(ownerIdentity(f, 'B'), statement.id)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');

    // Payout: proposed by ops, first approval by finance 1, second must be a different approver.
    const payout = await proposePayout(ops, {
      ownerStatementId: statement.id,
      beneficiary: { accountName: 'Owner A', bankName: 'GTBank', accountNumberMasked: '****1234' },
    });
    expect(payout.status).toBe('proposed');
    expect(payout.amountKobo).toBe(issued.totals.netKobo);
    await expect(proposePayout(ops, { ownerStatementId: statement.id, amountKobo: '1', beneficiary: { accountName: 'x', bankName: 'y', accountNumberMasked: '0000' } })).rejects.toSatisfy((e) => errorCode(e) === 'validation_failed');
    await expect(firstApprovePayout(financeIdentity(f, 1, false), payout.id)).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    await expect(firstApprovePayout(ops, payout.id)).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const first = await firstApprovePayout(financeIdentity(f, 1), payout.id);
    expect(first.status).toBe('first_approved');
    await expect(secondApprovePayout(financeIdentity(f, 1), payout.id)).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const approved = await secondApprovePayout(financeIdentity(f, 2), payout.id);
    expect(approved.status).toBe('approved');
    expect(approved.journalId).not.toBeNull();
    expect((await journalLinesByRef(f.dbs.owner, `payout:${payout.id}:approved`)).map((l) => l.code)).toEqual(['2100', '2400']);
    await expect(settlePayout(financeIdentity(f, 1), payout.id, { settlementReference: 'TRF-1' })).rejects.toSatisfy((e) => errorCode(e) === 'invalid_transition');
    const submitted = await submitPayout(financeIdentity(f, 1), payout.id);
    expect(submitted.status).toBe('submitted');
    const settled = await settlePayout(financeIdentity(f, 2), payout.id, { settlementReference: 'GTB-2026-01-0001' });
    expect(settled.status).toBe('settled');
    expect((await journalLinesByRef(f.dbs.owner, `payout:${payout.id}:settled`)).map((l) => l.code)).toEqual(['2400', '1000']);
    const ledger = await ledgerBalanced(f.dbs.owner);
    expect(ledger.unbalancedJournals).toBe(0);
    expect(ledger.debitKobo).toBe(ledger.creditKobo);
  });

  it('posts notices to active tenants, revokes access and terminates with a reason', async () => {
    const owner = ownerIdentity(f, 'A');
    expect(await postLeaseNotice(owner, leaseId, { title: 'Water outage', body: 'Tank cleaning on Saturday.' })).toEqual({ recipients: 1 });
    const parties = (await getLease(owner, leaseId)).parties;
    const tenantParty = parties.find((p) => p.userId === f.tenant1)!;
    const revoked = await revokeParty(owner, leaseId, tenantParty.id, { reason: 'moved out' });
    expect(revoked.accessStatus).toBe('revoked');
    await expect(getLease(tenantIdentity(f, 1), leaseId)).rejects.toSatisfy((e) => errorCode(e) === 'not_found');
    const current = await getLease(owner, leaseId);
    await expect(terminateLease(owner, leaseId, { reason: '', expectedVersion: current.version })).rejects.toSatisfy((e) => ['validation_failed', 'invalid_transition'].includes(errorCode(e)!));
    const terminated = await terminateLease(owner, leaseId, { reason: 'Tenant relocated abroad', terminatedOn: '2026-02-15', expectedVersion: current.version });
    expect(terminated.status).toBe('terminated');
    expect(terminated.terminationReason).toBe('Tenant relocated abroad');
    const schedule = await listSchedule(owner, leaseId);
    expect(schedule.filter((s) => s.status === 'waived')).toHaveLength(11);
    const page = await listLeases(owner, { limit: 10, status: 'terminated' });
    expect(page.items.map((l) => l.id)).toEqual([leaseId]);
    expect((await listLeases(ownerIdentity(f, 'B'), { limit: 10 })).items).toHaveLength(0);
  });
});

describe('proration and academic periods', () => {
  it('prorates a partial last period and freezes academic terms behind the student-housing flag', async () => {
    const owner = ownerIdentity(f, 'A');
    const lease = await createLease(owner, {
      propertyId: f.propertyA,
      kind: 'residential_annual',
      startDate: '2026-03-15',
      endDate: '2026-12-31',
      rentAmountKobo: '36500000',
      rentPeriod: 'annual',
      currency: 'NGN',
      depositKobo: '0',
      managementFeeBasis: 'none',
    });
    const active = await transitionLease(owner, lease.id, { to: 'active', expectedVersion: 1 });
    expect(active.status).toBe('active');
    const schedule = await listSchedule(owner, lease.id);
    expect(schedule).toHaveLength(1);
    // 292 days (15 Mar–31 Dec) of a 365-day year: 36,500,000 × 292 / 365 = 29,200,000.
    expect(schedule[0]!.amountKobo).toBe('29200000');
    expect((await listCharges(owner, lease.id))[0]!.description).toContain('prorated 292/365 days');

    const student = {
      propertyId: f.propertyA,
      kind: 'student_academic' as const,
      startDate: '2026-09-01',
      endDate: '2027-06-30',
      rentAmountKobo: '40000000',
      rentPeriod: 'term' as const,
      currency: 'NGN',
      depositKobo: '0',
      managementFeeBasis: 'none' as const,
      terms: {
        academicTerms: [
          { label: 'First semester', start: '2026-09-01', end: '2027-01-15' },
          { label: 'Second semester', start: '2027-02-01', end: '2027-06-30', amountKobo: '38000000' },
        ],
        guarantor: { name: 'Mrs Guarantor', relationship: 'parent', phoneE164: '+2348012345678' },
      },
    };
    await expect(createLease(owner, student)).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
    const flagged = ownerIdentity(f, 'A', ALL_FLAGS);
    const created = await createLease(flagged, student);
    expect(created.parties.find((p) => p.role === 'guarantor')?.name).toBe('Mrs Guarantor');
    await transitionLease(flagged, created.id, { to: 'active', expectedVersion: 1 });
    const terms = await listSchedule(flagged, created.id);
    expect(terms.map((t) => [t.periodStart, t.amountKobo])).toEqual([
      ['2026-09-01', '40000000'],
      ['2027-02-01', '38000000'],
    ]);
  });
});

describe('expansion variants', () => {
  it('gates assets, estates and short stays behind their flags', async () => {
    const owner = ownerIdentity(f, 'A');
    await expect(createAsset(owner, { propertyId: f.propertyA, name: 'Generator', category: 'power', condition: 'good' })).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
    await expect(createEstate(owner, { name: 'Lekki Gardens' })).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
    await expect(
      createStayBooking(owner, { propertyId: f.propertyA, guestName: 'Guest', checkIn: '2026-05-01', checkOut: '2026-05-03', nightlyRateKobo: '5000000', platformFeeKobo: '0', cleaningKobo: '0' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'feature_disabled');
  });

  it('short stay: no overlapping bookings per unit, turnover work order on check-out', async () => {
    await enableFlags(f.dbs.owner);
    const owner = ownerIdentity(f, 'B', ALL_FLAGS);
    const booking = await createStayBooking(owner, {
      propertyId: f.propertyB,
      unitId: f.unitB1,
      guestName: 'Ada Guest',
      checkIn: '2026-05-01',
      checkOut: '2026-05-04',
      nightlyRateKobo: '5000000',
      platformFeeKobo: '150000',
      cleaningKobo: '500000',
    });
    expect(booking.nights).toBe(3);
    expect(booking.grossKobo).toBe('15000000');
    await expect(
      createStayBooking(owner, { propertyId: f.propertyB, unitId: f.unitB1, guestName: 'Clash', checkIn: '2026-05-03', checkOut: '2026-05-05', nightlyRateKobo: '1', platformFeeKobo: '0', cleaningKobo: '0' }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'slot_unavailable');
    const adjacent = await createStayBooking(owner, { propertyId: f.propertyB, unitId: f.unitB1, guestName: 'Next', checkIn: '2026-05-04', checkOut: '2026-05-06', nightlyRateKobo: '1', platformFeeKobo: '0', cleaningKobo: '0' });
    expect(adjacent.status).toBe('requested');
    await transitionStayBooking(owner, booking.id, { to: 'confirmed' });
    await transitionStayBooking(owner, booking.id, { to: 'checked_in' });
    const out = await transitionStayBooking(owner, booking.id, { to: 'checked_out' });
    expect(out.turnoverWorkOrderId).not.toBeNull();
    const [wo] = await f.dbs.owner.select().from(schema.workOrders).where(eq(schema.workOrders.id, out.turnoverWorkOrderId!));
    expect(wo).toMatchObject({ category: 'turnover', propertyId: f.propertyB, unitId: f.unitB1 });
    const statement = await generateOwnerStatement(opsIdentity(f, ALL_FLAGS), { organizationId: f.orgB, propertyId: f.propertyB, periodStart: '2026-05-01', periodEnd: '2026-05-31' });
    expect(statement.lines.map((l) => l.kind)).toEqual(['short_stay_income', 'short_stay_expense']);
    expect(statement.totals.collectedKobo).toBe('0');
  });

  it('estates: separate ledger segment and service-charge invoices to every active lease', async () => {
    const ops = opsIdentity(f, ALL_FLAGS);
    const estate = await createEstate(ops, { organizationId: f.orgB, name: 'Ikeja Heights Estate', ledgerSegment: 'ikeja-heights', serviceChargePolicy: { amountKobo: '2500000', period: 'monthly' } });
    expect(estate.ledgerSegment).toBe('ikeja-heights');
    await attachProperty(ops, estate.id, f.propertyB);
    const owner = ownerIdentity(f, 'B', ALL_FLAGS);
    const lease = await createLease(owner, { propertyId: f.propertyB, unitId: f.unitB1, kind: 'residential_annual', startDate: '2026-01-01', endDate: '2026-12-31', rentAmountKobo: '50000000', rentPeriod: 'annual', currency: 'NGN', depositKobo: '0', managementFeeBasis: 'none' });
    await transitionLease(owner, lease.id, { to: 'active', expectedVersion: 1 });
    await expect(runServiceCharges(owner, estate.id, { periodStart: '2026-06-01', periodEnd: '2026-06-30' })).rejects.toSatisfy((e) => errorCode(e) === 'forbidden');
    const run = await runServiceCharges(ops, estate.id, { periodStart: '2026-06-01', periodEnd: '2026-06-30', dueDate: '2026-06-01' });
    expect(run).toMatchObject({ invoiced: 1, skipped: 0 });
    const [inv] = await f.dbs.owner.select().from(schema.invoices).where(eq(schema.invoices.id, run.invoiceIds[0]!));
    expect(inv).toMatchObject({ kind: 'service_charge', estateSegment: 'ikeja-heights', isRentOnBehalfOfOwner: true, organizationId: f.orgB, status: 'issued' });
    const [journal] = await f.dbs.owner.select().from(schema.journals).where(eq(schema.journals.businessEventRef, `invoice:${inv!.id}:issued`));
    expect(journal!.estateSegment).toBe('ikeja-heights');
    expect((await runServiceCharges(ops, estate.id, { periodStart: '2026-06-01', periodEnd: '2026-06-30' })).skipped).toBe(1);
  });
});

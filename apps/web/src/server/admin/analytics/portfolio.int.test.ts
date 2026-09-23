import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { chartOfAccounts } from '@simplexd/db/seed';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import { exportPortfolioSection, portfolioAnalytics, resolveRange } from './portfolio';

/**
 * Portfolio analytics: every figure equals a sum computed directly from the
 * fixtures (and from SQL), sections follow permissions, project managers
 * see only what they manage, and CSV exports reconcile to the figures.
 */

let dbs: TestDatabases;
let sfx: string;
let ops: AdminContext;
let finance: AdminContext;
let financeNoMfa: AdminContext;
let pm: AdminContext;
let support: AdminContext;
let orgId: string;
let serviceId: string;
let pmUserId: string;
const today = new Date();

function daysFromToday(days: number): string {
  const d = new Date(today.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split('\r\n');
  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  sfx = uniqueSuffix();
  const users = {
    ops: { id: `pa_ops_${sfx}`, name: 'Ops', email: `pa-ops-${sfx}@example.test` },
    fin: { id: `pa_fin_${sfx}`, name: 'Finance', email: `pa-fin-${sfx}@example.test` },
    pm: { id: `pa_pm_${sfx}`, name: 'PM', email: `pa-pm-${sfx}@example.test` },
    pm2: { id: `pa_pm2_${sfx}`, name: 'PM 2', email: `pa-pm2-${sfx}@example.test` },
    sup: { id: `pa_sup_${sfx}`, name: 'Support', email: `pa-sup-${sfx}@example.test` },
    cust: { id: `pa_cust_${sfx}`, name: 'Customer', email: `pa-cust-${sfx}@example.test` },
  };
  await insertStaffUser(dbs.owner, users.ops, ['operations_manager']);
  await insertStaffUser(dbs.owner, users.fin, ['finance']);
  await insertStaffUser(dbs.owner, users.pm, ['project_manager']);
  await insertStaffUser(dbs.owner, users.pm2, ['project_manager']);
  await insertStaffUser(dbs.owner, users.sup, ['support']);
  await insertStaffUser(dbs.owner, users.cust, []);
  ops = contextFor(dbs.app, identityFor(users.ops, ['operations_manager']));
  finance = contextFor(dbs.app, identityFor(users.fin, ['finance']));
  financeNoMfa = contextFor(dbs.app, identityFor(users.fin, ['finance'], { mfaVerified: false }));
  pm = contextFor(dbs.app, identityFor(users.pm, ['project_manager']));
  support = contextFor(dbs.app, identityFor(users.sup, ['support']));
  pmUserId = users.pm.id;
  orgId = `pa_org_${sfx}`;
  const owner = dbs.owner;
  await owner.insert(schema.organization).values({ id: orgId, name: `Portfolio org ${sfx}`, slug: orgId });
  await owner.insert(schema.member).values({ id: `m_${users.cust.id}`, organizationId: orgId, userId: users.cust.id, role: 'owner' });
  await owner.insert(schema.ledgerAccounts).values(chartOfAccounts).onConflictDoNothing({ target: schema.ledgerAccounts.code });
  const [svc] = await owner
    .insert(schema.services)
    .values({
      slug: `pa-svc-${sfx}`,
      name: `Analytics service ${sfx}`,
      category: 'core',
      shortDescription: 'test',
      workflowTemplateKey: 'property_management',
      publicationState: 'draft',
      sortOrder: 902,
    })
    .returning({ id: schema.services.id });
  serviceId = svc!.id;

  // Properties: P1 with two units (one occupied), P2 with a whole-property lease, P3 archived.
  const [p1, p2, p3] = await owner
    .insert(schema.properties)
    .values([
      { organizationId: orgId, name: `P1 ${sfx}`, kind: 'residential' },
      { organizationId: orgId, name: `P2 ${sfx}`, kind: 'commercial' },
      { organizationId: orgId, name: `P3 ${sfx}`, kind: 'land', archivedAt: new Date(today.getTime() - 86_400_000) },
    ])
    .returning({ id: schema.properties.id });
  const [u1, u2] = await owner
    .insert(schema.units)
    .values([
      { propertyId: p1!.id, label: 'A', unitType: 'flat' },
      { propertyId: p1!.id, label: 'B', unitType: 'flat' },
    ])
    .returning({ id: schema.units.id });
  await owner.insert(schema.leases).values([
    { organizationId: orgId, propertyId: p1!.id, unitId: u1!.id, kind: 'residential_annual', status: 'active', startDate: daysFromToday(-200), rentAmountKobo: 100_000_000n, rentPeriod: 'annual' },
    { organizationId: orgId, propertyId: p1!.id, unitId: u2!.id, kind: 'residential_annual', status: 'ended', startDate: daysFromToday(-400), endDate: daysFromToday(-30), rentAmountKobo: 100_000_000n, rentPeriod: 'annual' },
    { organizationId: orgId, propertyId: p2!.id, unitId: null, kind: 'commercial', status: 'active', startDate: daysFromToday(-10), rentAmountKobo: 500_000_000n, rentPeriod: 'annual' },
    { organizationId: orgId, propertyId: p3!.id, unitId: null, kind: 'commercial', status: 'draft', startDate: daysFromToday(-10), rentAmountKobo: 1n, rentPeriod: 'annual' },
  ]);

  // Rent invoices: overdue with a part payment, current, void (ignored), and a service invoice (ignored).
  const lease = (await owner.select({ id: schema.leases.id }).from(schema.leases).where(eq(schema.leases.propertyId, p1!.id)))[0]!;
  const invoiceBase = { organizationId: orgId, leaseId: lease.id, isRentOnBehalfOfOwner: true, issuedAt: new Date(today.getTime() - 60 * 86_400_000) };
  const [overdue, current] = await owner
    .insert(schema.invoices)
    .values([
      { ...invoiceBase, number: `PA-${sfx}-1`, kind: 'rent', status: 'partially_paid', subtotalKobo: 100_000n, totalKobo: 100_000n, amountPaidKobo: 30_000n, dueDate: daysFromToday(-45) },
      { ...invoiceBase, number: `PA-${sfx}-2`, kind: 'service_charge', status: 'issued', subtotalKobo: 50_000n, totalKobo: 50_000n, dueDate: daysFromToday(20) },
      { ...invoiceBase, number: `PA-${sfx}-3`, kind: 'rent', status: 'void', subtotalKobo: 9_000n, totalKobo: 9_000n, dueDate: daysFromToday(-90) },
      { ...invoiceBase, leaseId: null, isRentOnBehalfOfOwner: false, number: `PA-${sfx}-4`, kind: 'service', status: 'issued', subtotalKobo: 8_000n, totalKobo: 8_000n, dueDate: daysFromToday(-90) },
    ])
    .returning({ id: schema.invoices.id });
  await owner.insert(schema.allocations).values({
    organizationId: orgId,
    invoiceId: overdue!.id,
    amountKobo: 30_000n,
    dedupeKey: `pa-alloc-${sfx}`,
  });
  void current;

  // Projects: PR1 active with an approved budget, commitments, actuals and change orders; PR2 active without a budget; PR3 completed.
  const [pr1, pr2] = await owner
    .insert(schema.projects)
    .values([
      { organizationId: orgId, name: `PR1 ${sfx}`, kind: 'construction_monitoring', status: 'active', pmUserId },
      { organizationId: orgId, name: `PR2 ${sfx}`, kind: 'renovation', status: 'active', pmUserId: users.pm2.id },
      { organizationId: orgId, name: `PR3 ${sfx}`, kind: 'renovation', status: 'completed', pmUserId },
    ])
    .returning({ id: schema.projects.id });
  const [bv] = await owner
    .insert(schema.budgetVersions)
    .values({ projectId: pr1!.id, version: 1, status: 'approved', totalKobo: 1_000_000n, contingencyKobo: 100_000n })
    .returning({ id: schema.budgetVersions.id });
  await owner.update(schema.projects).set({ approvedBudgetVersionId: bv!.id }).where(eq(schema.projects.id, pr1!.id));
  await owner.insert(schema.budgetCommitments).values([
    { projectId: pr1!.id, kind: 'commitment', description: 'Contractor', amountKobo: 600_000n },
    { projectId: pr1!.id, kind: 'actual', description: 'Paid', amountKobo: 200_000n },
    { projectId: pr2!.id, kind: 'actual', description: 'Paid', amountKobo: 5_000n },
  ]);
  await owner.insert(schema.changeOrders).values([
    { organizationId: orgId, projectId: pr1!.id, number: 1, title: 'Extra', amountDeltaKobo: 50_000n, status: 'submitted', submittedAt: today },
    { organizationId: orgId, projectId: pr1!.id, number: 2, title: 'Done', amountDeltaKobo: 20_000n, status: 'approved' },
    { organizationId: orgId, projectId: pr2!.id, number: 1, title: 'Idea', amountDeltaKobo: 10_000n, status: 'draft' },
  ]);

  // Service requests created now: overdue SLA, completed, due soon, and one managed by the PM without an SLA.
  await owner.insert(schema.serviceRequests).values([
    { reference: `SRA-${sfx}-1`, organizationId: orgId, requestedByUserId: users.cust.id, serviceId, title: 'a', status: 'triage', slaDueAt: new Date(today.getTime() - 3_600_000) },
    { reference: `SRA-${sfx}-2`, organizationId: orgId, requestedByUserId: users.cust.id, serviceId, title: 'b', status: 'completed' },
    { reference: `SRA-${sfx}-3`, organizationId: orgId, requestedByUserId: users.cust.id, serviceId, title: 'c', status: 'in_progress', slaDueAt: new Date(today.getTime() + 2 * 3_600_000) },
    { reference: `SRA-${sfx}-4`, organizationId: orgId, requestedByUserId: users.cust.id, serviceId, title: 'd', status: 'inquiry', assignedPmUserId: pmUserId },
  ]);

  // Revenue journals: two inside the range for this organisation, one platform-level (no organisation), one outside the range.
  const accounts = await owner.select({ id: schema.ledgerAccounts.id, code: schema.ledgerAccounts.code }).from(schema.ledgerAccounts);
  const acc = (code: string) => accounts.find((a) => a.code === code)!.id;
  const postJournal = async (ref: string, postedAt: Date, organizationId: string | null, revenueCode: string, amount: bigint) => {
    await owner.transaction(async (tx) => {
      const [j] = await tx
        .insert(schema.journals)
        .values({ businessEventRef: ref, description: 'test revenue', sourceType: 'test', organizationId, postedAt })
        .returning({ id: schema.journals.id });
      await tx.insert(schema.journalLines).values([
        { journalId: j!.id, lineNo: 1, accountId: acc('1200'), debitKobo: amount, creditKobo: 0n, organizationId },
        { journalId: j!.id, lineNo: 2, accountId: acc(revenueCode), debitKobo: 0n, creditKobo: amount, organizationId },
      ]);
    });
  };
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 12));
  const twoMonthsAgo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 15, 12));
  await postJournal(`pa:${sfx}:1`, twoMonthsAgo, orgId, '4000', 100_000n);
  await postJournal(`pa:${sfx}:2`, monthStart, orgId, '4100', 60_000n);
  await postJournal(`pa:${sfx}:3`, monthStart, null, '4000', 7_000n);
  await postJournal(`pa:${sfx}:4`, new Date(Date.UTC(today.getUTCFullYear() - 3, 0, 1)), orgId, '4000', 9_999n);
});

afterAll(async () => {
  await closeDb();
  await dbs.close();
});

describe('portfolio analytics', () => {
  it('refuses actors without any analytics permission', async () => {
    await expect(portfolioAnalytics(support, {})).rejects.toBeInstanceOf(AuthorizationError);
    await expect(exportPortfolioSection(support, { section: 'properties' })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('derives every figure from the fixtures for one organisation', async () => {
    const data = await portfolioAnalytics(ops, { organizationId: orgId }, today);
    expect(data.properties).toEqual({
      propertyCount: 2,
      unitCount: 2,
      occupiedUnits: 1,
      vacantUnits: 1,
      occupancyPct: 50,
      activeLeases: 2,
      wholePropertyLeases: 1,
    });
    expect(data.arrears).toMatchObject({
      invoiceCount: 2,
      outstandingKobo: '120000',
      overdueKobo: '70000',
    });
    expect(data.arrears?.buckets).toMatchObject({ current: '50000', days_31_60: '70000' });
    expect(data.projects).toEqual({
      scope: 'all',
      activeCount: 2,
      withApprovedBudget: 1,
      approvedBudgetKobo: '1100000',
      forecastFinalCostKobo: '1100000',
      committedKobo: '600000',
      actualKobo: '205000',
      varianceKobo: '0',
      overBudgetCount: 0,
    });
    expect(data.changeOrders).toEqual({
      scope: 'all',
      openCount: 1,
      openExposureKobo: '50000',
      byStatus: { submitted: { count: 1, deltaKobo: '50000' }, draft: { count: 1, deltaKobo: '10000' } },
    });
    expect(data.serviceRequests).toMatchObject({
      scope: 'all',
      createdInRange: 4,
      byStatus: { triage: 1, completed: 1, in_progress: 1, inquiry: 1 },
      sla: { openWithDueTime: 2, openBreaches: 1, dueSoon: 1 },
    });
    expect(data.serviceRequests?.byService).toEqual([{ serviceId, serviceName: `Analytics service ${sfx}`, total: 4, open: 3 }]);
    expect(data.revenue?.totalKobo).toBe('160000');
    expect(data.revenue?.lineCount).toBe(2);
    expect(data.revenue?.months.reduce((n, m) => n + BigInt(m.revenueKobo), 0n)).toBe(160_000n);
    expect(data.revenue?.byAccount).toEqual([
      { code: '4000', name: expect.any(String), revenueKobo: '100000' },
      { code: '4100', name: expect.any(String), revenueKobo: '60000' },
    ]);
    // The same total straight from SQL.
    const range = resolveRange({}, today);
    const direct = await dbs.owner.execute<{ t: string }>(sql`
      select coalesce(sum(jl.credit_kobo - jl.debit_kobo), 0)::text as t
      from journal_lines jl join journals j on j.id = jl.journal_id join ledger_accounts la on la.id = jl.account_id
      where la.type = 'revenue' and j.organization_id = ${orgId} and j.posted_at >= ${range.fromTs} and j.posted_at < ${range.toExclusive}`);
    expect(direct.rows[0]?.t).toBe(data.revenue?.totalKobo);
  });

  it('returns only the sections each role may see, and scopes project managers to their own work', async () => {
    const fin = await portfolioAnalytics(finance, { organizationId: orgId }, today);
    expect(fin.revenue).not.toBeNull();
    expect(fin.arrears).not.toBeNull();
    expect(fin.properties).not.toBeNull();
    expect(fin.projects).toBeNull();
    expect(fin.serviceRequests).toBeNull();

    const mine = await portfolioAnalytics(pm, { organizationId: orgId }, today);
    expect(mine.projects).toMatchObject({ scope: 'assigned', activeCount: 1, withApprovedBudget: 1 });
    expect(mine.changeOrders).toMatchObject({ scope: 'assigned', openCount: 1 });
    expect(mine.serviceRequests).toMatchObject({ scope: 'assigned', createdInRange: 1, byStatus: { inquiry: 1 } });
    expect(mine.revenue).toBeNull();
    expect(mine.arrears).toBeNull();
  });

  it('exports the rows a figure was summed from, audits the export and gates finance sections behind MFA', async () => {
    const revenue = await exportPortfolioSection(ops, { section: 'revenue', organizationId: orgId }, today);
    const rows = parseCsv(revenue.csv);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + BigInt(r.revenue_kobo!), 0n)).toBe(160_000n);
    expect(revenue.filename).toMatch(/^simplexd-portfolio-revenue-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);

    const arrears = await exportPortfolioSection(ops, { section: 'arrears', organizationId: orgId }, today);
    const arrearsRows = parseCsv(arrears.csv);
    expect(arrearsRows.reduce((n, r) => n + BigInt(r.outstanding_kobo!), 0n)).toBe(120_000n);
    expect(arrearsRows.map((r) => r.bucket).sort()).toEqual(['current', 'days_31_60']);

    const units = await exportPortfolioSection(ops, { section: 'occupancy', organizationId: orgId }, today);
    expect(parseCsv(units.csv).filter((r) => r.occupied_as_of === '1')).toHaveLength(1);

    const projects = await exportPortfolioSection(pm, { section: 'projects', organizationId: orgId }, today);
    expect(parseCsv(projects.csv)).toHaveLength(1);

    await expect(
      exportPortfolioSection(financeNoMfa, { section: 'revenue', organizationId: orgId }, today),
    ).rejects.toMatchObject({ decision: { code: 'mfa_required' } });
    await expect(exportPortfolioSection(pm, { section: 'revenue', organizationId: orgId }, today)).rejects.toBeInstanceOf(AuthorizationError);

    const audits = await dbs.owner
      .select({ after: schema.auditEvents.after })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'analytics.portfolio_exported'));
    expect(audits.some((a) => (a.after as { section?: string; organizationId?: string })?.organizationId === orgId && (a.after as { section?: string }).section === 'revenue')).toBe(true);
  });

  it('validates the range', async () => {
    await expect(portfolioAnalytics(ops, { from: '2026-09-02', to: '2026-09-01' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(portfolioAnalytics(ops, { from: '2010-01-01', to: '2026-09-01' })).rejects.toMatchObject({ code: 'validation_failed' });
    const r = resolveRange({ from: '2026-07-10', to: '2026-09-05' }, new Date('2026-09-23T10:00:00Z'));
    expect(r.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(r.asOf).toBe('2026-09-05');
  });
});

import 'server-only';
import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type {
  PortfolioAnalyticsDto,
  PortfolioAnalyticsQuery,
  PortfolioExportQuery,
  PortfolioSection,
} from '@simplexd/contracts';
import { ApiError } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { AuthorizationError, type StaffPermission } from '@simplexd/domain/authz';
import { computeBudgetVariance } from '@simplexd/domain/projects';
import {
  ARREARS_BUCKETS,
  bucketForDaysOverdue,
  daysOverdue,
  type ArrearsBucket,
} from '@simplexd/domain/rentals';
import { recordAudit } from '@/lib/audit';
import { summarizeSla, type SlaState } from '@/lib/admin/sla';
import { lagosToday } from '@/lib/services/price-anchors';
import { authorize, can, transact, type AdminContext } from '../context';

/**
 * Portfolio analytics (brief §9 portfolio reporting, §11 admin analytics).
 * Every figure is derived from records at request time, never stored or
 * hard-coded. Each section loads its underlying rows once; the on-screen
 * totals are sums over those rows and the CSV export lists the same rows, so
 * summing an export column reproduces the figure shown (see
 * docs/workflows/admin-configuration.md, "Reconciling analytics exports").
 *
 * Point-in-time sections (properties, occupancy, arrears) are computed as at
 * the range end (or today when the range ends in the future). Projects and
 * change orders are the current position. Service requests and revenue are
 * the records created or posted inside the range. Dates use Africa/Lagos.
 */

export const ANALYTICS_PERMISSIONS: StaffPermission[] = [
  'finance.read',
  'rentals.manage',
  'projects.read_all',
  'service_requests.read_all',
];

const SECTION_PERMISSIONS: Record<PortfolioSection, StaffPermission[]> = {
  properties: ['rentals.manage', 'projects.read_all'],
  occupancy: ['rentals.manage', 'projects.read_all'],
  arrears: ['finance.read', 'rentals.manage'],
  projects: ['projects.read_all'],
  change_orders: ['projects.read_all'],
  service_requests: ['service_requests.read_all'],
  revenue: ['finance.read'],
};

/** Finance sections also need `finance.export` (MFA) to leave the system as a file. */
const EXPORT_EXTRA: Partial<Record<PortfolioSection, StaffPermission>> = {
  arrears: 'finance.export',
  revenue: 'finance.export',
};

export function canSeeSection(ctx: AdminContext, section: PortfolioSection): boolean {
  return SECTION_PERMISSIONS[section].some((p) => can(ctx, p));
}

export function canExportSection(ctx: AdminContext, section: PortfolioSection): boolean {
  const extra = EXPORT_EXTRA[section];
  return canSeeSection(ctx, section) && (!extra || can(ctx, extra));
}

export function exportNeedsMfa(section: PortfolioSection): boolean {
  return Boolean(EXPORT_EXTRA[section]);
}

/** Project managers without a broad role see only the projects and requests they manage. */
function assignedOnly(ctx: AdminContext): string | null {
  const roles = ctx.identity.actor.staffRoles;
  const broad = roles.some((r) => r === 'super_admin' || r === 'operations_manager');
  return !broad && roles.includes('project_manager') ? ctx.identity.actor.userId : null;
}

/* ---------------------------------------------------------------------- */
/* Range                                                                   */
/* ---------------------------------------------------------------------- */

export interface ResolvedRange {
  from: string;
  to: string;
  asOf: string;
  fromTs: Date;
  toExclusive: Date;
  asOfExclusive: Date;
  months: string[];
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Start of a Lagos calendar day as an instant (Lagos is UTC+1 all year). */
function lagosMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+01:00`);
}

export function resolveRange(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): ResolvedRange {
  const today = lagosToday(now);
  const to = query.to ?? today;
  let from = query.from;
  if (!from) {
    const d = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 11);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) throw new ApiError('validation_failed', 'from must be on or before to');
  const spanDays = (lagosMidnight(to).getTime() - lagosMidnight(from).getTime()) / 86_400_000;
  if (spanDays > 366 * 5)
    throw new ApiError('validation_failed', 'the range can cover at most five years');
  const asOf = to < today ? to : today;
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const last = to.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return {
    from,
    to,
    asOf,
    fromTs: lagosMidnight(from),
    toExclusive: lagosMidnight(addDays(to, 1)),
    asOfExclusive: lagosMidnight(addDays(asOf, 1)),
    months,
  };
}

interface Scope {
  range: ResolvedRange;
  organizationId: string | null;
  pmUserId: string | null;
  now: Date;
}

const big = (v: string | number | bigint | null | undefined): bigint =>
  v === null || v === undefined ? 0n : BigInt(v);

/* ---------------------------------------------------------------------- */
/* Section loaders: each returns the underlying rows                        */
/* ---------------------------------------------------------------------- */

export interface PropertyRow {
  propertyId: string;
  name: string;
  kind: string;
  organizationId: string;
  createdAt: string;
  unitCount: number;
  occupiedUnits: number;
  activeLeases: number;
  wholePropertyLeases: number;
}

export interface UnitRow {
  unitId: string;
  propertyId: string;
  propertyName: string;
  organizationId: string;
  label: string;
  recordedStatus: string;
  occupied: boolean;
  leaseIds: string;
}

async function loadPortfolio(
  tx: Transaction,
  s: Scope,
): Promise<{ properties: PropertyRow[]; units: UnitRow[] }> {
  const p = schema.properties;
  const propertyWhere = and(
    lt(p.createdAt, s.range.asOfExclusive),
    or(isNull(p.archivedAt), gte(p.archivedAt, s.range.asOfExclusive)),
    s.organizationId ? eq(p.organizationId, s.organizationId) : undefined,
  );
  const props = await tx
    .select({
      id: p.id,
      name: p.name,
      kind: p.kind,
      organizationId: p.organizationId,
      createdAt: p.createdAt,
    })
    .from(p)
    .where(propertyWhere)
    .orderBy(asc(p.name), asc(p.id));
  const ids = props.map((r) => r.id);
  const units =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: schema.units.id,
            propertyId: schema.units.propertyId,
            label: schema.units.label,
            status: schema.units.status,
          })
          .from(schema.units)
          .where(
            and(
              inArray(schema.units.propertyId, ids),
              lt(schema.units.createdAt, s.range.asOfExclusive),
            ),
          )
          .orderBy(asc(schema.units.label));
  const l = schema.leases;
  const leases =
    ids.length === 0
      ? []
      : await tx
          .select({ id: l.id, propertyId: l.propertyId, unitId: l.unitId })
          .from(l)
          .where(
            and(
              inArray(l.propertyId, ids),
              notInArray(l.status, ['draft', 'pending_signature']),
              sql`${l.startDate} <= ${s.range.asOf}`,
              or(isNull(l.endDate), sql`${l.endDate} >= ${s.range.asOf}`),
              or(isNull(l.terminatedAt), gte(l.terminatedAt, s.range.asOfExclusive)),
            ),
          );
  const leasesByUnit = new Map<string, string[]>();
  for (const lease of leases) {
    if (!lease.unitId) continue;
    const list = leasesByUnit.get(lease.unitId) ?? [];
    list.push(lease.id);
    leasesByUnit.set(lease.unitId, list);
  }
  const propName = new Map(props.map((r) => [r.id, r]));
  const unitRows: UnitRow[] = units.map((u) => ({
    unitId: u.id,
    propertyId: u.propertyId,
    propertyName: propName.get(u.propertyId)?.name ?? '',
    organizationId: propName.get(u.propertyId)?.organizationId ?? '',
    label: u.label,
    recordedStatus: u.status,
    occupied: (leasesByUnit.get(u.id)?.length ?? 0) > 0,
    leaseIds: (leasesByUnit.get(u.id) ?? []).join(' '),
  }));
  const propertyRows: PropertyRow[] = props.map((r) => {
    const own = unitRows.filter((u) => u.propertyId === r.id);
    const ownLeases = leases.filter((x) => x.propertyId === r.id);
    return {
      propertyId: r.id,
      name: r.name,
      kind: r.kind,
      organizationId: r.organizationId,
      createdAt: r.createdAt.toISOString(),
      unitCount: own.length,
      occupiedUnits: own.filter((u) => u.occupied).length,
      activeLeases: ownLeases.length,
      wholePropertyLeases: ownLeases.filter((x) => !x.unitId).length,
    };
  });
  return { properties: propertyRows, units: unitRows };
}

export interface ArrearsRow {
  invoiceId: string;
  number: string;
  organizationId: string;
  kind: string;
  leaseId: string | null;
  issuedOn: string;
  dueDate: string;
  totalKobo: string;
  allocatedKobo: string;
  outstandingKobo: string;
  daysOverdue: number;
  bucket: ArrearsBucket;
}

async function loadArrears(tx: Transaction, s: Scope): Promise<ArrearsRow[]> {
  const i = schema.invoices;
  const rows = await tx
    .select({
      id: i.id,
      number: i.number,
      organizationId: i.organizationId,
      kind: i.kind,
      leaseId: i.leaseId,
      issuedOn: sql<string>`to_char(${i.issuedAt} at time zone 'Africa/Lagos', 'YYYY-MM-DD')`,
      dueDate: i.dueDate,
      totalKobo: sql<string>`${i.totalKobo}::text`,
      allocatedKobo: sql<string>`(
        select coalesce(sum(a.amount_kobo), 0)::text from allocations a
        where a.invoice_id = ${i.id} and a.allocated_at < ${s.range.asOfExclusive}
      )`,
    })
    .from(i)
    .where(
      and(
        inArray(i.kind, ['rent', 'service_charge']),
        sql`${i.leaseId} is not null`,
        notInArray(i.status, ['draft', 'void']),
        lt(i.issuedAt, s.range.asOfExclusive),
        s.organizationId ? eq(i.organizationId, s.organizationId) : undefined,
      ),
    )
    .orderBy(asc(i.dueDate), asc(i.number));
  const out: ArrearsRow[] = [];
  for (const r of rows) {
    const outstanding = big(r.totalKobo) - big(r.allocatedKobo);
    if (outstanding <= 0n) continue;
    const due = r.dueDate ?? r.issuedOn;
    const days = daysOverdue(due, s.range.asOf);
    out.push({
      invoiceId: r.id,
      number: r.number,
      organizationId: r.organizationId,
      kind: r.kind,
      leaseId: r.leaseId,
      issuedOn: r.issuedOn,
      dueDate: due,
      totalKobo: r.totalKobo,
      allocatedKobo: r.allocatedKobo,
      outstandingKobo: outstanding.toString(),
      daysOverdue: days,
      bucket: bucketForDaysOverdue(days),
    });
  }
  return out;
}

export interface ProjectRow {
  projectId: string;
  name: string;
  organizationId: string;
  pmUserId: string | null;
  hasApprovedBudget: boolean;
  approvedTotalKobo: string;
  committedKobo: string;
  actualKobo: string;
  forecastFinalCostKobo: string;
  varianceKobo: string;
  pendingChangeOrderKobo: string;
  budgetStatus: string;
}

async function loadProjects(tx: Transaction, s: Scope): Promise<ProjectRow[]> {
  const p = schema.projects;
  const rows = await tx
    .select({
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      pmUserId: p.pmUserId,
      baseKobo: sql<string | null>`${schema.budgetVersions.totalKobo}::text`,
      contingencyKobo: sql<string | null>`${schema.budgetVersions.contingencyKobo}::text`,
      committedKobo: sql<string>`(select coalesce(sum(c.amount_kobo),0)::text from budget_commitments c where c.project_id = ${p.id} and c.kind = 'commitment')`,
      actualKobo: sql<string>`(select coalesce(sum(c.amount_kobo),0)::text from budget_commitments c where c.project_id = ${p.id} and c.kind = 'actual')`,
      approvedCoKobo: sql<string>`(select coalesce(sum(co.amount_delta_kobo),0)::text from change_orders co where co.project_id = ${p.id} and co.status = 'approved')`,
      pendingCoKobo: sql<string>`(select coalesce(sum(co.amount_delta_kobo),0)::text from change_orders co where co.project_id = ${p.id} and co.status in ('submitted','customer_review','staff_review'))`,
    })
    .from(p)
    .leftJoin(schema.budgetVersions, eq(schema.budgetVersions.id, p.approvedBudgetVersionId))
    .where(
      and(
        eq(p.status, 'active'),
        s.organizationId ? eq(p.organizationId, s.organizationId) : undefined,
        s.pmUserId ? eq(p.pmUserId, s.pmUserId) : undefined,
      ),
    )
    .orderBy(asc(p.name), asc(p.id));
  return rows.map((r) => {
    const v = computeBudgetVariance({
      approvedBaseKobo: r.baseKobo === null ? null : big(r.baseKobo),
      contingencyKobo: big(r.contingencyKobo),
      committedKobo: big(r.committedKobo),
      actualKobo: big(r.actualKobo),
      approvedChangeOrderDeltaKobo: big(r.approvedCoKobo),
      pendingChangeOrderDeltaKobo: big(r.pendingCoKobo),
    });
    return {
      projectId: r.id,
      name: r.name,
      organizationId: r.organizationId,
      pmUserId: r.pmUserId,
      hasApprovedBudget: v.hasApprovedBudget,
      approvedTotalKobo: (v.approvedTotalKobo ?? 0n).toString(),
      committedKobo: v.committedKobo.toString(),
      actualKobo: v.actualKobo.toString(),
      forecastFinalCostKobo: (v.forecastFinalCostKobo ?? 0n).toString(),
      varianceKobo: (v.varianceKobo ?? 0n).toString(),
      pendingChangeOrderKobo: v.pendingChangeOrderDeltaKobo.toString(),
      budgetStatus: v.status,
    };
  });
}

export interface ChangeOrderRow {
  changeOrderId: string;
  projectId: string;
  projectName: string;
  organizationId: string;
  number: number;
  title: string;
  status: string;
  pendingDecision: boolean;
  amountDeltaKobo: string;
  submittedAt: string | null;
}

const PENDING_CO = ['submitted', 'customer_review', 'staff_review'] as const;

async function loadChangeOrders(tx: Transaction, s: Scope): Promise<ChangeOrderRow[]> {
  const co = schema.changeOrders;
  const p = schema.projects;
  const rows = await tx
    .select({
      id: co.id,
      projectId: p.id,
      projectName: p.name,
      organizationId: p.organizationId,
      number: co.number,
      title: co.title,
      status: co.status,
      amountDeltaKobo: sql<string>`${co.amountDeltaKobo}::text`,
      submittedAt: co.submittedAt,
    })
    .from(co)
    .innerJoin(p, eq(p.id, co.projectId))
    .where(
      and(
        inArray(co.status, ['draft', ...PENDING_CO]),
        notInArray(p.status, ['cancelled', 'archived']),
        s.organizationId ? eq(p.organizationId, s.organizationId) : undefined,
        s.pmUserId ? eq(p.pmUserId, s.pmUserId) : undefined,
      ),
    )
    .orderBy(asc(p.name), asc(co.number));
  return rows.map((r) => ({
    changeOrderId: r.id,
    projectId: r.projectId,
    projectName: r.projectName,
    organizationId: r.organizationId,
    number: r.number,
    title: r.title,
    status: r.status,
    pendingDecision: (PENDING_CO as readonly string[]).includes(r.status),
    amountDeltaKobo: r.amountDeltaKobo,
    submittedAt: r.submittedAt?.toISOString() ?? null,
  }));
}

export interface ServiceRequestRow {
  serviceRequestId: string;
  reference: string;
  serviceId: string;
  serviceName: string;
  organizationId: string;
  status: string;
  createdAt: string;
  slaDueAt: string | null;
  slaState: SlaState;
}

const CLOSED_SR = new Set(['completed', 'rejected', 'cancelled']);

async function loadServiceRequests(tx: Transaction, s: Scope): Promise<ServiceRequestRow[]> {
  const sr = schema.serviceRequests;
  const rows = await tx
    .select({
      id: sr.id,
      reference: sr.reference,
      serviceId: sr.serviceId,
      serviceName: schema.services.name,
      organizationId: sr.organizationId,
      status: sr.status,
      createdAt: sr.createdAt,
      slaDueAt: sr.slaDueAt,
    })
    .from(sr)
    .innerJoin(schema.services, eq(schema.services.id, sr.serviceId))
    .where(
      and(
        gte(sr.createdAt, s.range.fromTs),
        lt(sr.createdAt, s.range.toExclusive),
        s.organizationId ? eq(sr.organizationId, s.organizationId) : undefined,
        s.pmUserId ? eq(sr.assignedPmUserId, s.pmUserId) : undefined,
      ),
    )
    .orderBy(asc(sr.createdAt), asc(sr.reference));
  return rows.map((r) => {
    const due = r.slaDueAt?.toISOString() ?? null;
    return {
      serviceRequestId: r.id,
      reference: r.reference,
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      organizationId: r.organizationId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      slaDueAt: due,
      slaState: summarizeSla(due, r.status, s.now).state,
    };
  });
}

export interface RevenueRow {
  journalLineId: string;
  journalId: string;
  businessEventRef: string;
  postedAt: string;
  month: string;
  organizationId: string | null;
  accountCode: string;
  accountName: string;
  debitKobo: string;
  creditKobo: string;
  revenueKobo: string;
}

async function loadRevenue(tx: Transaction, s: Scope): Promise<RevenueRow[]> {
  const jl = schema.journalLines;
  const j = schema.journals;
  const la = schema.ledgerAccounts;
  const where: SQL | undefined = and(
    eq(la.type, 'revenue'),
    gte(j.postedAt, s.range.fromTs),
    lt(j.postedAt, s.range.toExclusive),
    s.organizationId ? eq(j.organizationId, s.organizationId) : undefined,
  );
  const rows = await tx
    .select({
      id: jl.id,
      journalId: j.id,
      businessEventRef: j.businessEventRef,
      postedAt: j.postedAt,
      month: sql<string>`to_char(${j.postedAt} at time zone 'Africa/Lagos', 'YYYY-MM')`,
      organizationId: j.organizationId,
      code: la.code,
      name: la.name,
      debitKobo: sql<string>`${jl.debitKobo}::text`,
      creditKobo: sql<string>`${jl.creditKobo}::text`,
    })
    .from(jl)
    .innerJoin(j, eq(j.id, jl.journalId))
    .innerJoin(la, eq(la.id, jl.accountId))
    .where(where)
    .orderBy(asc(j.postedAt), asc(j.id), asc(jl.lineNo));
  return rows.map((r) => ({
    journalLineId: r.id,
    journalId: r.journalId,
    businessEventRef: r.businessEventRef,
    postedAt: r.postedAt.toISOString(),
    month: r.month,
    organizationId: r.organizationId,
    accountCode: r.code,
    accountName: r.name,
    debitKobo: r.debitKobo,
    creditKobo: r.creditKobo,
    revenueKobo: (big(r.creditKobo) - big(r.debitKobo)).toString(),
  }));
}

/* ---------------------------------------------------------------------- */
/* Aggregation (pure: summaries are sums over the same rows as the export) */
/* ---------------------------------------------------------------------- */

export function summarizePortfolio(properties: PropertyRow[]) {
  const unitCount = properties.reduce((n, p) => n + p.unitCount, 0);
  const occupiedUnits = properties.reduce((n, p) => n + p.occupiedUnits, 0);
  return {
    propertyCount: properties.length,
    unitCount,
    occupiedUnits,
    vacantUnits: unitCount - occupiedUnits,
    occupancyPct: unitCount === 0 ? null : Math.round((occupiedUnits / unitCount) * 1000) / 10,
    activeLeases: properties.reduce((n, p) => n + p.activeLeases, 0),
    wholePropertyLeases: properties.reduce((n, p) => n + p.wholePropertyLeases, 0),
  };
}

export function summarizeArrears(rows: ArrearsRow[], asOf: string) {
  const buckets = Object.fromEntries(ARREARS_BUCKETS.map((b) => [b, 0n])) as Record<
    ArrearsBucket,
    bigint
  >;
  let outstanding = 0n;
  for (const r of rows) {
    buckets[r.bucket] += big(r.outstandingKobo);
    outstanding += big(r.outstandingKobo);
  }
  return {
    asOf,
    invoiceCount: rows.length,
    outstandingKobo: outstanding.toString(),
    overdueKobo: (outstanding - buckets.current).toString(),
    buckets: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, v.toString()]),
    ) as Record<string, string>,
  };
}

export function summarizeProjects(rows: ProjectRow[]) {
  const withBudget = rows.filter((r) => r.hasApprovedBudget);
  const sum = (list: ProjectRow[], key: keyof ProjectRow) =>
    list.reduce((acc, r) => acc + big(r[key] as string), 0n).toString();
  return {
    activeCount: rows.length,
    withApprovedBudget: withBudget.length,
    approvedBudgetKobo: sum(withBudget, 'approvedTotalKobo'),
    forecastFinalCostKobo: sum(withBudget, 'forecastFinalCostKobo'),
    committedKobo: sum(rows, 'committedKobo'),
    actualKobo: sum(rows, 'actualKobo'),
    varianceKobo: sum(withBudget, 'varianceKobo'),
    overBudgetCount: rows.filter(
      (r) => r.budgetStatus === 'over_committed' || r.budgetStatus === 'over_spent',
    ).length,
  };
}

export function summarizeChangeOrders(rows: ChangeOrderRow[]) {
  const byStatus: Record<string, { count: number; deltaKobo: string }> = {};
  let exposure = 0n;
  let open = 0;
  for (const r of rows) {
    const entry = byStatus[r.status] ?? { count: 0, deltaKobo: '0' };
    entry.count += 1;
    entry.deltaKobo = (big(entry.deltaKobo) + big(r.amountDeltaKobo)).toString();
    byStatus[r.status] = entry;
    if (r.pendingDecision) {
      open += 1;
      exposure += big(r.amountDeltaKobo);
    }
  }
  return { openCount: open, openExposureKobo: exposure.toString(), byStatus };
}

export function summarizeServiceRequests(rows: ServiceRequestRow[], activePolicies: number) {
  const byStatus: Record<string, number> = {};
  const services = new Map<
    string,
    { serviceId: string; serviceName: string; total: number; open: number }
  >();
  let openWithDueTime = 0;
  let openBreaches = 0;
  let dueSoon = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const svc = services.get(r.serviceId) ?? {
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      total: 0,
      open: 0,
    };
    svc.total += 1;
    if (!CLOSED_SR.has(r.status)) svc.open += 1;
    services.set(r.serviceId, svc);
    if (r.slaState === 'ok' || r.slaState === 'due_soon' || r.slaState === 'overdue')
      openWithDueTime += 1;
    if (r.slaState === 'overdue') openBreaches += 1;
    if (r.slaState === 'due_soon') dueSoon += 1;
  }
  return {
    createdInRange: rows.length,
    byStatus,
    byService: [...services.values()].sort(
      (a, b) => b.total - a.total || a.serviceName.localeCompare(b.serviceName),
    ),
    sla: { activePolicies, openWithDueTime, openBreaches, dueSoon },
  };
}

export function summarizeRevenue(rows: RevenueRow[], months: string[]) {
  const byMonth = new Map(months.map((m) => [m, 0n]));
  const byAccount = new Map<string, { code: string; name: string; total: bigint }>();
  let total = 0n;
  for (const r of rows) {
    const v = big(r.revenueKobo);
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0n) + v);
    const acc = byAccount.get(r.accountCode) ?? {
      code: r.accountCode,
      name: r.accountName,
      total: 0n,
    };
    acc.total += v;
    byAccount.set(r.accountCode, acc);
    total += v;
  }
  return {
    totalKobo: total.toString(),
    lineCount: rows.length,
    months: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, revenueKobo: v.toString() })),
    byAccount: [...byAccount.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => ({ code: a.code, name: a.name, revenueKobo: a.total.toString() })),
  };
}

/* ---------------------------------------------------------------------- */
/* Entry points                                                            */
/* ---------------------------------------------------------------------- */

function assertAnySection(ctx: AdminContext): void {
  if (!ctx.identity.session)
    throw new AuthorizationError({
      allowed: false,
      code: 'unauthenticated',
      reason: 'sign in required',
    });
  if (!ANALYTICS_PERMISSIONS.some((p) => can(ctx, p)))
    throw new AuthorizationError({
      allowed: false,
      code: 'no_permission',
      reason: `portfolio analytics needs one of ${ANALYTICS_PERMISSIONS.join(', ')}`,
    });
}

function scopeFor(
  ctx: AdminContext,
  query: { from?: string; to?: string; organizationId?: string },
  now: Date,
): Scope {
  return {
    range: resolveRange(query, now),
    organizationId: query.organizationId ?? null,
    pmUserId: assignedOnly(ctx),
    now,
  };
}

/** Section figures the actor may see; sections without permission are null. */
export async function portfolioAnalytics(
  ctx: AdminContext,
  query: PortfolioAnalyticsQuery,
  now: Date = new Date(),
): Promise<PortfolioAnalyticsDto> {
  assertAnySection(ctx);
  const s = scopeFor(ctx, query, now);
  const scopeLabel = s.pmUserId ? ('assigned' as const) : ('all' as const);
  return transact(ctx, async (tx) => {
    const out: PortfolioAnalyticsDto = {
      range: { from: s.range.from, to: s.range.to, asOf: s.range.asOf },
      organizationId: s.organizationId,
      generatedAt: now.toISOString(),
      properties: null,
      arrears: null,
      projects: null,
      changeOrders: null,
      serviceRequests: null,
      revenue: null,
    };
    if (canSeeSection(ctx, 'properties')) {
      out.properties = summarizePortfolio((await loadPortfolio(tx, s)).properties);
    }
    if (canSeeSection(ctx, 'arrears')) {
      out.arrears = summarizeArrears(await loadArrears(tx, s), s.range.asOf);
    }
    if (canSeeSection(ctx, 'projects')) {
      out.projects = { scope: scopeLabel, ...summarizeProjects(await loadProjects(tx, s)) };
      out.changeOrders = {
        scope: scopeLabel,
        ...summarizeChangeOrders(await loadChangeOrders(tx, s)),
      };
    }
    if (canSeeSection(ctx, 'service_requests')) {
      const [policies] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.slaPolicies)
        .where(eq(schema.slaPolicies.active, true));
      out.serviceRequests = {
        scope: scopeLabel,
        ...summarizeServiceRequests(await loadServiceRequests(tx, s), policies?.n ?? 0),
      };
    }
    if (canSeeSection(ctx, 'revenue')) {
      out.revenue = summarizeRevenue(await loadRevenue(tx, s), s.range.months);
    }
    return out;
  });
}

/* ---------------------------------------------------------------------- */
/* CSV export                                                              */
/* ---------------------------------------------------------------------- */

type Cell = string | number | boolean | null | undefined;

/** RFC 4180 quoting; text that could start a spreadsheet formula is neutralised, numbers are kept. */
function cell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const numeric = /^-?\d+(\.\d+)?$/.test(v);
  const safe = !numeric && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv<T>(rows: T[], columns: Array<[string, (r: T) => Cell]>): string {
  const lines = [columns.map(([h]) => cell(h)).join(',')];
  for (const r of rows) lines.push(columns.map(([, f]) => cell(f(r))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface PortfolioExport {
  filename: string;
  csv: string;
  rowCount: number;
}

export async function exportPortfolioSection(
  ctx: AdminContext,
  query: PortfolioExportQuery,
  now: Date = new Date(),
): Promise<PortfolioExport> {
  const section = query.section;
  const allowed = SECTION_PERMISSIONS[section].find((p) => can(ctx, p));
  if (!allowed)
    throw new AuthorizationError({
      allowed: false,
      code: 'no_permission',
      reason: `exporting ${section} needs one of ${SECTION_PERMISSIONS[section].join(', ')}`,
    });
  authorize(ctx, allowed);
  const extra = EXPORT_EXTRA[section];
  if (extra) authorize(ctx, extra);
  const s = scopeFor(ctx, query, now);
  return transact(ctx, async (tx) => {
    let csv: string;
    let rowCount: number;
    switch (section) {
      case 'properties': {
        const rows = (await loadPortfolio(tx, s)).properties;
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['property_id', (r) => r.propertyId],
          ['name', (r) => r.name],
          ['kind', (r) => r.kind],
          ['organization_id', (r) => r.organizationId],
          ['created_at', (r) => r.createdAt],
          ['units', (r) => r.unitCount],
          ['occupied_units', (r) => r.occupiedUnits],
          ['active_leases', (r) => r.activeLeases],
          ['whole_property_leases', (r) => r.wholePropertyLeases],
        ]);
        break;
      }
      case 'occupancy': {
        const rows = (await loadPortfolio(tx, s)).units;
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['unit_id', (r) => r.unitId],
          ['property_id', (r) => r.propertyId],
          ['property_name', (r) => r.propertyName],
          ['organization_id', (r) => r.organizationId],
          ['unit_label', (r) => r.label],
          ['recorded_status', (r) => r.recordedStatus],
          ['occupied_as_of', (r) => (r.occupied ? 1 : 0)],
          ['active_lease_ids', (r) => r.leaseIds],
        ]);
        break;
      }
      case 'arrears': {
        const rows = await loadArrears(tx, s);
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['invoice_id', (r) => r.invoiceId],
          ['invoice_number', (r) => r.number],
          ['organization_id', (r) => r.organizationId],
          ['kind', (r) => r.kind],
          ['lease_id', (r) => r.leaseId],
          ['issued_on', (r) => r.issuedOn],
          ['due_date', (r) => r.dueDate],
          ['total_kobo', (r) => r.totalKobo],
          ['allocated_to_as_of_kobo', (r) => r.allocatedKobo],
          ['outstanding_kobo', (r) => r.outstandingKobo],
          ['days_overdue', (r) => r.daysOverdue],
          ['bucket', (r) => r.bucket],
        ]);
        break;
      }
      case 'projects': {
        const rows = await loadProjects(tx, s);
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['project_id', (r) => r.projectId],
          ['name', (r) => r.name],
          ['organization_id', (r) => r.organizationId],
          ['has_approved_budget', (r) => (r.hasApprovedBudget ? 1 : 0)],
          ['approved_total_kobo', (r) => r.approvedTotalKobo],
          ['committed_kobo', (r) => r.committedKobo],
          ['actual_kobo', (r) => r.actualKobo],
          ['forecast_final_cost_kobo', (r) => r.forecastFinalCostKobo],
          ['variance_kobo', (r) => r.varianceKobo],
          ['pending_change_orders_kobo', (r) => r.pendingChangeOrderKobo],
          ['budget_status', (r) => r.budgetStatus],
        ]);
        break;
      }
      case 'change_orders': {
        const rows = await loadChangeOrders(tx, s);
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['change_order_id', (r) => r.changeOrderId],
          ['project_id', (r) => r.projectId],
          ['project_name', (r) => r.projectName],
          ['organization_id', (r) => r.organizationId],
          ['number', (r) => r.number],
          ['title', (r) => r.title],
          ['status', (r) => r.status],
          ['pending_decision', (r) => (r.pendingDecision ? 1 : 0)],
          ['amount_delta_kobo', (r) => r.amountDeltaKobo],
          ['submitted_at', (r) => r.submittedAt],
        ]);
        break;
      }
      case 'service_requests': {
        const rows = await loadServiceRequests(tx, s);
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['service_request_id', (r) => r.serviceRequestId],
          ['reference', (r) => r.reference],
          ['service_id', (r) => r.serviceId],
          ['service_name', (r) => r.serviceName],
          ['organization_id', (r) => r.organizationId],
          ['status', (r) => r.status],
          ['created_at', (r) => r.createdAt],
          ['sla_due_at', (r) => r.slaDueAt],
          ['sla_state_at_export', (r) => r.slaState],
        ]);
        break;
      }
      case 'revenue': {
        const rows = await loadRevenue(tx, s);
        rowCount = rows.length;
        csv = toCsv(rows, [
          ['journal_line_id', (r) => r.journalLineId],
          ['journal_id', (r) => r.journalId],
          ['business_event_ref', (r) => r.businessEventRef],
          ['posted_at', (r) => r.postedAt],
          ['month_lagos', (r) => r.month],
          ['organization_id', (r) => r.organizationId],
          ['account_code', (r) => r.accountCode],
          ['account_name', (r) => r.accountName],
          ['debit_kobo', (r) => r.debitKobo],
          ['credit_kobo', (r) => r.creditKobo],
          ['revenue_kobo', (r) => r.revenueKobo],
        ]);
        break;
      }
    }
    await recordAudit(tx, ctx.identity, {
      action: 'analytics.portfolio_exported',
      entityType: 'portfolio_analytics',
      after: {
        section,
        from: s.range.from,
        to: s.range.to,
        asOf: s.range.asOf,
        organizationId: s.organizationId,
        scope: s.pmUserId ? 'assigned' : 'all',
        rowCount,
      },
      correlationId: ctx.correlationId,
    });
    const stamp = `${s.range.from}_${s.range.to}`;
    return {
      filename: `simplexd-portfolio-${section.replace('_', '-')}-${stamp}.csv`,
      csv,
      rowCount,
    };
  });
}

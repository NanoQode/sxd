import 'server-only';
import { inArray } from 'drizzle-orm';
import type {
  LeaseBalanceDto,
  LeaseDto,
  LeaseListQuery,
  OwnerStatementDto,
  OwnerStatementListQuery,
  RentChargeDto,
  RentScheduleDto,
  WorkOrderDto,
  WorkOrderListQuery,
} from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';
import { getWorkOrder, listWorkOrders } from '@/server/maintenance/work-orders';
import { getLease, listLeases } from '@/server/rentals/leases';
import { listOwnerStatements } from '@/server/rentals/owner-statements';
import { getLeaseBalance, listCharges, listSchedule } from '@/server/rentals/schedules';
import { listStaffAssignees } from '@/server/leads/admin';
import { attempt, can, orgNames, staffTx, userNames, type Loaded } from './context';
import { listInvitablePartners } from './partners';

/** Property names and unit labels for a set of rows. */
async function placeNames(identity: RequestIdentity, rows: Array<{ organizationId: string; propertyId?: string | null; unitId?: string | null }>) {
  return staffTx(identity, async (tx) => {
    const propertyIds = [...new Set(rows.map((r) => r.propertyId).filter((v): v is string => Boolean(v)))];
    const unitIds = [...new Set(rows.map((r) => r.unitId).filter((v): v is string => Boolean(v)))];
    const props = propertyIds.length
      ? await tx.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(inArray(schema.properties.id, propertyIds))
      : [];
    const units = unitIds.length
      ? await tx.select({ id: schema.units.id, label: schema.units.label }).from(schema.units).where(inArray(schema.units.id, unitIds))
      : [];
    const orgs = await orgNames(
      tx,
      rows.map((r) => r.organizationId),
    );
    return { props: new Map(props.map((p) => [p.id, p.name])), units: new Map(units.map((u) => [u.id, u.label])), orgs };
  });
}

export interface LeaseRow extends LeaseDto {
  organizationName: string;
  propertyName: string | null;
  unitLabel: string | null;
  tenantNames: string[];
}

export async function listLeasesView(identity: RequestIdentity, query: LeaseListQuery): Promise<{ items: LeaseRow[]; nextCursor: string | null }> {
  const page = await listLeases(identity, query);
  const names = await placeNames(identity, page.items);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((l) => ({
      ...l,
      organizationName: names.orgs.get(l.organizationId) ?? l.organizationId,
      propertyName: names.props.get(l.propertyId) ?? null,
      unitLabel: l.unitId ? (names.units.get(l.unitId) ?? null) : null,
      tenantNames: l.parties.filter((p) => p.role === 'tenant' && p.accessStatus !== 'revoked').map((p) => p.name),
    })),
  };
}

export interface LeaseWorkspace {
  lease: LeaseRow;
  schedule: Loaded<RentScheduleDto[]>;
  charges: Loaded<RentChargeDto[]>;
  balance: Loaded<LeaseBalanceDto>;
  workOrders: Loaded<WorkOrderDto[]>;
  canManage: boolean;
}

export async function leaseWorkspace(identity: RequestIdentity, id: string): Promise<LeaseWorkspace> {
  const lease = await getLease(identity, id);
  const [names, schedule, charges, balance, workOrders] = await Promise.all([
    placeNames(identity, [lease]),
    attempt(() => listSchedule(identity, id)),
    attempt(() => listCharges(identity, id)),
    attempt(() => getLeaseBalance(identity, id)),
    attempt(() => listWorkOrders(identity, { leaseId: id, limit: 50 }).then((p) => p.items)),
  ]);
  return {
    lease: {
      ...lease,
      organizationName: names.orgs.get(lease.organizationId) ?? lease.organizationId,
      propertyName: names.props.get(lease.propertyId) ?? null,
      unitLabel: lease.unitId ? (names.units.get(lease.unitId) ?? null) : null,
      tenantNames: lease.parties.filter((p) => p.role === 'tenant').map((p) => p.name),
    },
    schedule,
    charges,
    balance,
    workOrders,
    canManage: can(identity, 'rentals.manage'),
  };
}

export interface WorkOrderRow extends WorkOrderDto {
  organizationName: string;
  propertyName: string | null;
  unitLabel: string | null;
}

export async function listWorkOrdersView(identity: RequestIdentity, query: WorkOrderListQuery): Promise<{ items: WorkOrderRow[]; nextCursor: string | null }> {
  const page = await listWorkOrders(identity, query);
  const names = await placeNames(identity, page.items);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((w) => ({
      ...w,
      organizationName: names.orgs.get(w.organizationId) ?? w.organizationId,
      propertyName: names.props.get(w.propertyId) ?? null,
      unitLabel: w.unitId ? (names.units.get(w.unitId) ?? null) : null,
    })),
  };
}

export interface WorkOrderWorkspace {
  workOrder: WorkOrderRow;
  reportedByName: string | null;
  approvedByName: string | null;
  verifiedByName: string | null;
  assignees: Array<{ userId: string; name: string; kind: 'staff' | 'partner' }>;
  canManage: boolean;
}

export async function workOrderWorkspace(identity: RequestIdentity, id: string): Promise<WorkOrderWorkspace> {
  const wo = await getWorkOrder(identity, id);
  const [names, people, staff, partners] = await Promise.all([
    placeNames(identity, [wo]),
    staffTx(identity, (tx) => userNames(tx, [wo.reportedByUserId, wo.approvedBy, wo.verifiedBy])),
    listStaffAssignees(identity).catch(() => []),
    listInvitablePartners(identity).catch(() => []),
  ]);
  return {
    workOrder: {
      ...wo,
      organizationName: names.orgs.get(wo.organizationId) ?? wo.organizationId,
      propertyName: names.props.get(wo.propertyId) ?? null,
      unitLabel: wo.unitId ? (names.units.get(wo.unitId) ?? null) : null,
    },
    reportedByName: wo.reportedByUserId ? (people.get(wo.reportedByUserId)?.name ?? null) : null,
    approvedByName: wo.approvedBy ? (people.get(wo.approvedBy)?.name ?? null) : null,
    verifiedByName: wo.verifiedBy ? (people.get(wo.verifiedBy)?.name ?? null) : null,
    assignees: [
      ...staff.map((s) => ({ userId: s.userId, name: s.name, kind: 'staff' as const })),
      ...partners.map((p) => ({ userId: p.userId, name: `${p.name} (${p.partnerType})`, kind: 'partner' as const })),
    ],
    canManage: can(identity, 'maintenance.manage') || can(identity, 'rentals.manage'),
  };
}

export interface StatementRow extends OwnerStatementDto {
  organizationName: string;
  propertyName: string | null;
}

export async function listStatementsView(identity: RequestIdentity, query: OwnerStatementListQuery): Promise<{ items: StatementRow[]; nextCursor: string | null }> {
  const page = await listOwnerStatements(identity, query);
  const names = await placeNames(identity, page.items);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((s) => ({
      ...s,
      organizationName: names.orgs.get(s.organizationId) ?? s.organizationId,
      propertyName: s.propertyId ? (names.props.get(s.propertyId) ?? null) : null,
    })),
  };
}

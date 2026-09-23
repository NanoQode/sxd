import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  type LeaseBalanceDto,
  type RentChargeDto,
  type TenantLeaseSummary,
  type TenantNoticeDto,
  type TenantReceiptDto,
  type WorkOrderCreate,
  type WorkOrderDto,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeTenant, type TenantPermission } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import { createWorkOrder, listWorkOrders } from '@/server/maintenance/work-orders';
import { chargesWithBalances, computeLeaseBalance, refreshLeaseAllocations } from './schedules';
import {
  elevated,
  loadLeaseTerms,
  requireUserId,
  toLeaseDto,
  today,
  type LeaseRow,
  type ServiceOptions,
} from './shared';

/**
 * Tenant portal. Everything starts from the caller's own active lease
 * parties: the SQL reads only return leases where the caller is an active
 * party (`app.can_access_lease`), the tenant policy is checked with the
 * party list as the resource relationship, and every list is filtered to
 * those lease ids. A tenant never sees another tenant's records, the owner's
 * portfolio or the owner ledger (management fees, statements, payouts).
 */

interface TenantLease {
  lease: LeaseRow;
  role: (typeof schema.leaseParties.$inferSelect)['role'];
}

async function myLeases(tx: DbExecutor, userId: string): Promise<TenantLease[]> {
  const rows = await tx
    .select({ lease: schema.leases, role: schema.leaseParties.role })
    .from(schema.leaseParties)
    .innerJoin(schema.leases, eq(schema.leases.id, schema.leaseParties.leaseId))
    .where(
      and(eq(schema.leaseParties.userId, userId), eq(schema.leaseParties.accessStatus, 'active')),
    )
    .orderBy(desc(schema.leases.startDate));
  return rows.map((r) => ({ lease: r.lease, role: r.role }));
}

function assertTenant(
  identity: RequestIdentity,
  permission: TenantPermission,
  leaseId: string | null,
): void {
  const userId = requireUserId(identity);
  assertAllowed(
    authorizeTenant(identity.actor, permission, {
      type: 'lease',
      ...(leaseId ? { id: leaseId } : {}),
      assigneeUserIds: [userId],
    }),
  );
}

async function requireMyLease(
  tx: DbExecutor,
  identity: RequestIdentity,
  leaseId: string,
  permission: TenantPermission,
): Promise<TenantLease> {
  const userId = requireUserId(identity);
  const mine = (await myLeases(tx, userId)).find((l) => l.lease.id === leaseId);
  if (!mine) throw new ApiError('not_found', 'lease not found');
  assertTenant(identity, permission, leaseId);
  return mine;
}

async function summary(
  tx: Transaction,
  identity: RequestIdentity,
  entry: TenantLease,
): Promise<TenantLeaseSummary> {
  const [property] = await tx
    .select({
      id: schema.properties.id,
      name: schema.properties.name,
      address: schema.properties.address,
    })
    .from(schema.properties)
    .where(eq(schema.properties.id, entry.lease.propertyId));
  const [unit] = entry.lease.unitId
    ? await tx
        .select({ id: schema.units.id, label: schema.units.label })
        .from(schema.units)
        .where(eq(schema.units.id, entry.lease.unitId))
    : [];
  // The terms note is readable by the owner organisation only; the tenant gets the inventory they signed.
  const terms = await elevated(tx, identity.ctx, () => loadLeaseTerms(tx, entry.lease.id));
  const {
    parties: _p,
    managementFeeBasis: _b,
    managementFeeBps: _f,
    managementFeeFixedKobo: _x,
    ...lease
  } = toLeaseDto(
    entry.lease,
    [],
    terms
      ? {
          ...(terms.moveInInventory ? { moveInInventory: terms.moveInInventory } : {}),
          ...(terms.academicTerms ? { academicTerms: terms.academicTerms } : {}),
        }
      : null,
  );
  return {
    lease,
    property: {
      id: property!.id,
      name: property!.name,
      address: (property!.address as Record<string, unknown> | null) ?? null,
    },
    unit: unit ? { id: unit.id, label: unit.label } : null,
    myRole: entry.role,
  };
}

export async function listMyLeases(identity: RequestIdentity): Promise<TenantLeaseSummary[]> {
  const userId = requireUserId(identity);
  assertTenant(identity, 'tenant.lease.view', null);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const out: TenantLeaseSummary[] = [];
    for (const entry of await myLeases(tx, userId)) out.push(await summary(tx, identity, entry));
    return out;
  });
}

export async function getMyLease(
  identity: RequestIdentity,
  leaseId: string,
): Promise<TenantLeaseSummary> {
  return withActor(getDb(), identity.ctx, async (tx) =>
    summary(tx, identity, await requireMyLease(tx, identity, leaseId, 'tenant.lease.view')),
  );
}

export async function getMyBalance(
  identity: RequestIdentity,
  leaseId: string,
): Promise<LeaseBalanceDto> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { lease } = await requireMyLease(tx, identity, leaseId, 'tenant.balances.view');
    await refreshLeaseAllocations(tx, identity, lease.id);
    return computeLeaseBalance(tx, lease, today());
  });
}

export async function listMyCharges(
  identity: RequestIdentity,
  leaseId: string,
): Promise<RentChargeDto[]> {
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { lease } = await requireMyLease(tx, identity, leaseId, 'tenant.balances.view');
    await refreshLeaseAllocations(tx, identity, lease.id);
    return chargesWithBalances(tx, lease.id);
  });
}

/** Receipts for invoices of the tenant's own leases where the tenant is the invoiced customer. */
export async function listMyReceipts(identity: RequestIdentity): Promise<TenantReceiptDto[]> {
  const userId = requireUserId(identity);
  assertTenant(identity, 'tenant.receipts.view', null);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const leaseIds = (await myLeases(tx, userId)).map((l) => l.lease.id);
    if (leaseIds.length === 0) return [];
    const rows = await tx
      .select({ receipt: schema.receipts, invoiceNumber: schema.invoices.number })
      .from(schema.receipts)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.receipts.invoiceId))
      .where(
        and(inArray(schema.invoices.leaseId, leaseIds), eq(schema.invoices.customerUserId, userId)),
      )
      .orderBy(desc(schema.receipts.issuedAt));
    return rows.map((r) => ({
      id: r.receipt.id,
      number: r.receipt.number,
      invoiceId: r.receipt.invoiceId,
      invoiceNumber: r.invoiceNumber,
      amountKobo: r.receipt.amountKobo.toString(),
      issuedAt: r.receipt.issuedAt.toISOString(),
    }));
  });
}

export async function listMyTickets(
  identity: RequestIdentity,
  leaseId?: string,
): Promise<WorkOrderDto[]> {
  const userId = requireUserId(identity);
  assertTenant(identity, 'tenant.maintenance.request', null);
  const leaseIds = await withActor(getDb(), identity.ctx, async (tx) =>
    (await myLeases(tx, userId)).map((l) => l.lease.id),
  );
  if (leaseIds.length === 0) return [];
  if (leaseId && !leaseIds.includes(leaseId)) throw new ApiError('not_found', 'lease not found');
  const out: WorkOrderDto[] = [];
  for (const id of leaseId ? [leaseId] : leaseIds) {
    const page = await listWorkOrders(identity, { leaseId: id, limit: 100 });
    out.push(...page.items.filter((w) => w.reportedByUserId === userId));
  }
  return out;
}

/** A tenant's maintenance ticket on their own lease; the request is scoped to that lease's property/unit. */
export async function createMyTicket(
  identity: RequestIdentity,
  leaseId: string,
  input: Pick<WorkOrderCreate, 'title' | 'description' | 'category' | 'priority'>,
  options: ServiceOptions = {},
): Promise<WorkOrderDto> {
  const lease = await withActor(
    getDb(),
    identity.ctx,
    async (tx) => (await requireMyLease(tx, identity, leaseId, 'tenant.maintenance.request')).lease,
  );
  return createWorkOrder(
    identity,
    {
      ...input,
      propertyId: lease.propertyId,
      unitId: lease.unitId,
      leaseId: lease.id,
      assetId: null,
      estateId: null,
    },
    options,
  );
}

export async function listMyAppointments(identity: RequestIdentity) {
  const userId = requireUserId(identity);
  assertTenant(identity, 'tenant.appointments.view', null);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schema.appointments.id,
        kind: schema.appointments.kind,
        status: schema.appointments.status,
        startsAt: schema.appointments.startsAt,
        endsAt: schema.appointments.endsAt,
        topic: schema.appointments.topic,
        locationNote: schema.appointments.locationNote,
      })
      .from(schema.appointments)
      .where(eq(schema.appointments.customerUserId, userId))
      .orderBy(desc(schema.appointments.startsAt))
      .limit(100);
    return rows.map((r) => ({
      ...r,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
    }));
  });
}

/** Approved notices addressed to the tenant (posted by the owner or staff on a lease). */
export async function listMyNotices(identity: RequestIdentity): Promise<TenantNoticeDto[]> {
  const userId = requireUserId(identity);
  assertTenant(identity, 'tenant.notices.view', null);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.kind, 'tenant_notice'),
        ),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(100);
    return rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      leaseId: n.entityId,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt ? n.readAt.toISOString() : null,
    }));
  });
}

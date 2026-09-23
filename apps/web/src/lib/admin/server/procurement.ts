import 'server-only';
import type {
  DeliveryDto,
  PurchaseOrderDetail,
  PurchaseOrderDto,
  PurchaseOrderListQuery,
  RfqComparisonDto,
  RfqDetail,
  RfqDto,
  RfqListQuery,
  SupplierDirectoryEntry,
} from '@simplexd/contracts';
import type { RequestIdentity } from '@/lib/auth/session';
import { listDeliveries } from '@/server/procurement/deliveries';
import { getPurchaseOrder, listPurchaseOrders } from '@/server/procurement/purchase-orders';
import { getRfq, getRfqComparison, listRfqs } from '@/server/procurement/rfqs';
import { listSupplierDirectory } from '@/server/procurement/suppliers';
import { attempt, can, orgNames, staffTx, userNames, type Loaded } from './context';
import { listInvitablePartners } from './partners';

type WithOrg<T> = T & { organizationName: string };

async function withOrgNames<T extends { organizationId: string }>(
  identity: RequestIdentity,
  rows: T[],
): Promise<Array<WithOrg<T>>> {
  const names = await staffTx(identity, (tx) =>
    orgNames(
      tx,
      rows.map((r) => r.organizationId),
    ),
  );
  return rows.map((r) => ({
    ...r,
    organizationName: names.get(r.organizationId) ?? r.organizationId,
  }));
}

export async function listRfqsView(
  identity: RequestIdentity,
  query: RfqListQuery,
): Promise<{ items: Array<WithOrg<RfqDto>>; nextCursor: string | null }> {
  const page = await listRfqs(identity, query);
  return { items: await withOrgNames(identity, page.items), nextCursor: page.nextCursor };
}

export async function listPurchaseOrdersView(
  identity: RequestIdentity,
  query: PurchaseOrderListQuery,
): Promise<{ items: Array<WithOrg<PurchaseOrderDto>>; nextCursor: string | null }> {
  const page = await listPurchaseOrders(identity, query);
  return { items: await withOrgNames(identity, page.items), nextCursor: page.nextCursor };
}

export async function listDeliveriesView(
  identity: RequestIdentity,
  query: { status?: DeliveryDto['status']; cursor?: string; limit: number },
) {
  return listDeliveries(identity, {
    status: query.status,
    cursor: query.cursor,
    limit: query.limit,
  });
}

export async function supplierDirectory(
  identity: RequestIdentity,
  query: { material?: SupplierDirectoryEntry['material'] },
) {
  return listSupplierDirectory(identity, {
    material: query.material as never,
    includeArchived: 'false',
  });
}

export interface RfqWorkspace {
  rfq: RfqDetail;
  organizationName: string;
  createdByName: string | null;
  comparison: Loaded<RfqComparisonDto>;
  orders: PurchaseOrderDto[];
  suppliers: Array<{
    userId: string;
    name: string;
    email: string;
    partnerType: string;
    verificationStatus: string;
  }>;
  canManage: boolean;
}

export async function rfqWorkspace(identity: RequestIdentity, id: string): Promise<RfqWorkspace> {
  const rfq = await getRfq(identity, id);
  const [comparison, orders, suppliers, extras] = await Promise.all([
    attempt(() => getRfqComparison(identity, id)),
    listPurchaseOrders(identity, { rfqId: id, limit: 50 }).then((p) => p.items),
    listInvitablePartners(identity).catch(() => []),
    staffTx(identity, async (tx) => ({
      orgs: await orgNames(tx, [rfq.organizationId]),
      names: await userNames(tx, [rfq.createdBy]),
    })),
  ]);
  return {
    rfq,
    organizationName: extras.orgs.get(rfq.organizationId) ?? rfq.organizationId,
    createdByName: rfq.createdBy ? (extras.names.get(rfq.createdBy)?.name ?? null) : null,
    comparison,
    orders,
    suppliers,
    canManage: can(identity, 'procurement.manage'),
  };
}

export interface PurchaseOrderWorkspace {
  po: PurchaseOrderDetail;
  organizationName: string;
  deliveries: DeliveryDto[];
  canManage: boolean;
}

export async function purchaseOrderWorkspace(
  identity: RequestIdentity,
  id: string,
): Promise<PurchaseOrderWorkspace> {
  const po = await getPurchaseOrder(identity, id);
  const [deliveries, orgs] = await Promise.all([
    listDeliveries(identity, { purchaseOrderId: id, limit: 100 }).then((p) => p.items),
    staffTx(identity, (tx) => orgNames(tx, [po.organizationId])),
  ]);
  return {
    po,
    organizationName: orgs.get(po.organizationId) ?? po.organizationId,
    deliveries,
    canManage: can(identity, 'procurement.manage'),
  };
}

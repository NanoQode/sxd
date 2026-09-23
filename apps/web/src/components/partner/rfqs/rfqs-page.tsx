'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { DeliveryDto, Page, PurchaseOrderDto, RfqDto } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatNairaString,
} from '@simplexd/ui';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { DeadlineCountdown, DualTime, LoadingBlock, RequestFailed } from '../common';

export function RfqsPage() {
  const p = usePartner();
  const params = useSearchParams();
  const tab =
    params.get('tab') === 'orders'
      ? 'orders'
      : params.get('tab') === 'deliveries'
        ? 'deliveries'
        : 'rfqs';
  const rfqs = useQuery({
    queryKey: ['partner', 'rfqs'],
    queryFn: () => partnerFetch<Page<RfqDto>>(withQuery('/api/v1/rfqs', { limit: 100 })),
  });
  const orders = useQuery({
    queryKey: ['partner', 'orders'],
    queryFn: () =>
      partnerFetch<Page<PurchaseOrderDto>>(withQuery('/api/v1/purchase-orders', { limit: 100 })),
  });
  const deliveries = useQuery({
    queryKey: ['partner', 'deliveries'],
    queryFn: () => partnerFetch<Page<DeliveryDto>>(withQuery('/api/v1/deliveries', { limit: 100 })),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="RFQs & orders"
        description="Requests for quotation you were invited to, purchase orders naming you as supplier, and deliveries with any discrepancies raised against them."
      />
      <Tabs defaultValue={tab}>
        <TabsList aria-label="Procurement views">
          <TabsTrigger value="rfqs">RFQs</TabsTrigger>
          <TabsTrigger value="orders">Purchase orders</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries & disputes</TabsTrigger>
        </TabsList>
        <TabsContent value="rfqs" className="pt-4">
          {rfqs.isPending ? (
            <LoadingBlock label="Loading RFQs" />
          ) : rfqs.isError ? (
            <RequestFailed error={rfqs.error} onRetry={() => void rfqs.refetch()} context="RFQs" />
          ) : rfqs.data.items.length === 0 ? (
            <EmptyState
              title="No RFQs"
              description="Staff invite suppliers to an RFQ; invited requests appear here with their deadline."
            />
          ) : (
            <DataTable
              caption="Requests for quotation"
              rows={rfqs.data.items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.title}
              columns={[
                {
                  key: 'title',
                  header: 'RFQ',
                  cell: (r) => (
                    <div>
                      <Link
                        href={`/partner/rfqs/${r.id}`}
                        className="font-medium text-primary underline"
                      >
                        {r.title}
                      </Link>
                      <div className="text-xs text-fg-muted">{r.reference}</div>
                    </div>
                  ),
                },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'market', header: 'Deliver to', cell: (r) => r.deliveryMarketName ?? '—' },
                {
                  key: 'deadline',
                  header: 'Deadline',
                  cell: (r) => (
                    <div className="space-y-1">
                      <DualTime iso={r.deadlineAt} zone={p.timeZone} />
                      {r.status === 'sent' ? (
                        <DeadlineCountdown deadlineIso={r.deadlineAt} />
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </TabsContent>
        <TabsContent value="orders" className="pt-4">
          {orders.isPending ? (
            <LoadingBlock label="Loading purchase orders" />
          ) : orders.isError ? (
            <RequestFailed
              error={orders.error}
              onRetry={() => void orders.refetch()}
              context="Purchase orders"
            />
          ) : orders.data.items.length === 0 ? (
            <EmptyState
              title="No purchase orders"
              description="Orders issued to you after an RFQ is awarded are listed here for acknowledgement."
            />
          ) : (
            <DataTable
              caption="Purchase orders"
              rows={orders.data.items}
              rowKey={(o) => o.id}
              rowLabel={(o) => o.number}
              columns={[
                {
                  key: 'number',
                  header: 'Order',
                  cell: (o) => (
                    <Link
                      href={`/partner/orders/${o.id}`}
                      className="font-medium text-primary underline"
                    >
                      {o.number}
                    </Link>
                  ),
                },
                { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
                { key: 'total', header: 'Total', cell: (o) => formatNairaString(o.totalKobo) },
                {
                  key: 'issued',
                  header: 'Issued',
                  cell: (o) => <DualTime iso={o.issuedAt} zone={p.timeZone} />,
                },
                {
                  key: 'expected',
                  header: 'Expected delivery',
                  cell: (o) => <DualTime iso={o.expectedDeliveryAt} zone={p.timeZone} />,
                },
              ]}
            />
          )}
        </TabsContent>
        <TabsContent value="deliveries" className="pt-4">
          {deliveries.isPending ? (
            <LoadingBlock label="Loading deliveries" />
          ) : deliveries.isError ? (
            <RequestFailed
              error={deliveries.error}
              onRetry={() => void deliveries.refetch()}
              context="Deliveries"
            />
          ) : deliveries.data.items.length === 0 ? (
            <EmptyState
              title="No deliveries recorded"
              description="Staff record deliveries against your orders; discrepancies they raise are shown here so you can respond through Messages."
            />
          ) : (
            <DataTable
              caption="Deliveries"
              rows={deliveries.data.items}
              rowKey={(d) => d.id}
              rowLabel={(d) => `Delivery for ${d.purchaseOrderNumber}`}
              columns={[
                {
                  key: 'order',
                  header: 'Order',
                  cell: (d) => (
                    <Link
                      href={`/partner/orders/${d.purchaseOrderId}`}
                      className="font-medium text-primary underline"
                    >
                      {d.purchaseOrderNumber}
                    </Link>
                  ),
                },
                { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
                {
                  key: 'delivered',
                  header: 'Delivered',
                  cell: (d) => <DualTime iso={d.deliveredAt} zone={p.timeZone} />,
                },
                {
                  key: 'disputes',
                  header: 'Discrepancies',
                  cell: (d) =>
                    d.discrepancies.length === 0 ? (
                      <span className="text-fg-muted">None</span>
                    ) : (
                      <Badge
                        tone={
                          d.discrepancies.some(
                            (x) => x.status === 'open' || x.status === 'supplier_notified',
                          )
                            ? 'warning'
                            : 'neutral'
                        }
                      >
                        {d.discrepancies.length} raised
                      </Badge>
                    ),
                },
              ]}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

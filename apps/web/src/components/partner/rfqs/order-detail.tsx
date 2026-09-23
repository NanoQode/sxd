'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { DeliveryDto, Page, PurchaseOrderDetail } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Field,
  Input,
  PageHeader,
  StatusBadge,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { DetailList, DualTime, LoadingBlock, RequestFailed } from '../common';
import { DeliveryDiscrepancyThreads } from './discrepancy-thread';

export function OrderDetailView({ orderId }: { orderId: string }) {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [supplierRef, setSupplierRef] = useState('');
  const [expected, setExpected] = useState('');
  const order = useQuery({
    queryKey: ['partner', 'order', orderId],
    queryFn: () => partnerFetch<PurchaseOrderDetail>(`/api/v1/purchase-orders/${orderId}`),
  });
  const deliveries = useQuery({
    queryKey: ['partner', 'deliveries', orderId],
    queryFn: () =>
      partnerFetch<Page<DeliveryDto>>(
        withQuery('/api/v1/deliveries', { purchaseOrderId: orderId, limit: 100 }),
      ),
  });
  const acknowledge = useMutation({
    mutationFn: () =>
      partnerFetch(`/api/v1/purchase-orders/${orderId}/acknowledge`, {
        body: {
          supplierRef: supplierRef.trim() || null,
          expectedDeliveryAt: expected ? new Date(expected).toISOString() : null,
          expectedVersion: order.data?.version,
        },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Order acknowledged' });
      void qc.invalidateQueries({ queryKey: ['partner', 'order', orderId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'orders'] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not acknowledge', description: errorMessage(err) }),
  });

  if (order.isPending) return <LoadingBlock rows={5} label="Loading order" />;
  if (order.isError)
    return (
      <RequestFailed
        error={order.error}
        onRetry={() => void order.refetch()}
        context="Purchase order"
      />
    );
  const o = order.data;
  const disputes = (deliveries.data?.items ?? []).flatMap((d) =>
    d.discrepancies.map((x) => ({ ...x, delivery: d })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/partner/rfqs?tab=orders" className="underline">
            Purchase orders
          </Link>
        }
        title={`Order ${o.number}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} />
            <span>
              Total {formatNairaString(o.totalKobo)} incl. delivery{' '}
              {formatNairaString(o.deliveryKobo)}
            </span>
          </span>
        }
      />
      <Card>
        <CardContent className="pt-5">
          <DetailList
            items={[
              { label: 'Issued', value: <DualTime iso={o.issuedAt} zone={p.timeZone} /> },
              {
                label: 'Expected delivery',
                value: <DualTime iso={o.expectedDeliveryAt} zone={p.timeZone} />,
              },
              { label: 'Your reference', value: o.supplierRef ?? '—' },
              { label: 'Delivery progress', value: humanize(o.deliveryProgress.status) },
            ]}
          />
        </CardContent>
      </Card>
      {o.status === 'issued' ? (
        <Card>
          <CardHeader>
            <CardTitle>Acknowledge this order</CardTitle>
            <p className="text-xs text-fg-muted">
              Confirms you received the order and expect to deliver. Optional reference and date
              help the site team plan.
            </p>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                acknowledge.mutate();
              }}
            >
              <Field label="Your order reference" htmlFor="po-ref">
                {({ id }) => (
                  <Input
                    id={id}
                    maxLength={120}
                    value={supplierRef}
                    onChange={(e) => setSupplierRef(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Expected delivery" htmlFor="po-expected" hint="Your local time.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    type="datetime-local"
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex items-end">
                <Button type="submit" loading={acknowledge.isPending}>
                  Acknowledge order
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Order lines"
            rows={o.lines}
            rowKey={(l) => l.lineId}
            rowLabel={(l) => l.specification}
            columns={[
              {
                key: 'item',
                header: 'Item',
                cell: (l) => `${humanize(l.material)} · ${l.specification}`,
              },
              { key: 'qty', header: 'Ordered', cell: (l) => `${l.quantity} ${l.unit}` },
              {
                key: 'price',
                header: 'Your price',
                cell: (l) => (
                  <span>
                    {formatNairaString(l.unitPriceKobo)} / {l.supplierUnit}
                    {l.conversion ? (
                      <span className="block text-xs text-fg-muted">
                        1 {l.conversion.fromUnit} = {l.conversion.factor} {l.conversion.toUnit} (
                        {humanize(l.conversion.basis)})
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'total',
                header: 'Line total',
                cell: (l) => formatNairaString(l.lineTotalKobo),
              },
              {
                key: 'received',
                header: 'Received',
                cell: (l) => {
                  const v = o.deliveryProgress.lines.find((x) => x.lineId === l.lineId);
                  return v ? (
                    <span>
                      {v.received} of {v.ordered}{' '}
                      <Badge
                        tone={
                          v.status === 'complete'
                            ? 'success'
                            : v.status === 'over'
                              ? 'warning'
                              : v.status === 'short'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {humanize(v.status)}
                      </Badge>
                    </span>
                  ) : (
                    '—'
                  );
                },
              },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Deliveries and discrepancies</CardTitle>
          <p className="text-xs text-fg-muted">
            Recorded by the receiving site team. A discrepancy is a dispute about quantity, damage
            or specification: respond to it here with a proposed resolution and evidence; staff
            accept or reject the proposal and you are notified either way.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {deliveries.isPending ? (
            <LoadingBlock rows={2} label="Loading deliveries" />
          ) : deliveries.isError ? (
            <RequestFailed
              error={deliveries.error}
              onRetry={() => void deliveries.refetch()}
              context="Deliveries"
            />
          ) : deliveries.data.items.length === 0 ? (
            <p className="text-sm text-fg-muted">No deliveries recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {deliveries.data.items.map((d) => (
                <li key={d.id} className="rounded-md border border-border p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={d.status} />
                    <span>
                      Delivered <DualTime iso={d.deliveredAt} zone={p.timeZone} />
                    </span>
                  </p>
                  <ul className="mt-2 space-y-1">
                    {d.lines.map((l) => {
                      const line = o.lines.find((x) => x.lineId === l.lineId);
                      return (
                        <li key={l.lineId}>
                          {line ? line.specification : l.lineId}: received {l.quantityReceived}{' '}
                          {line?.unit ?? ''}
                          {l.note ? ` — ${l.note}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                  {d.note ? <p className="mt-2 text-fg-muted">{d.note}</p> : null}
                  {d.discrepancies.length > 0 ? (
                    <DeliveryDiscrepancyThreads deliveryId={d.id} order={o} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {deliveries.data && deliveries.data.items.length > 0 && disputes.length === 0 ? (
            <Alert tone="success" title="No discrepancies">
              Nothing has been disputed on this order.
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

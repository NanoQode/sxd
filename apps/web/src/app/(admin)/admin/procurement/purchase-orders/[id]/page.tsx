import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { discrepancyKindSchema } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { purchaseOrderWorkspace } from '@/lib/admin/server/procurement';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';
import { RecordDelivery } from './_components/record-delivery';

export const metadata: Metadata = { title: 'Purchase order' };
export const dynamic = 'force-dynamic';

const DISCREPANCY_NEXT: Record<
  string,
  Array<'supplier_notified' | 'resolved' | 'credited' | 'returned'>
> = {
  open: ['supplier_notified', 'resolved', 'credited', 'returned'],
  supplier_notified: ['resolved', 'credited', 'returned'],
};

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/procurement');
  const { id } = await params;
  const loaded = await attempt(() => purchaseOrderWorkspace(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This purchase order" />;
  }
  const { po, deliveries, canManage, organizationName } = loaded.value;
  const progress = new Map(po.deliveryProgress.lines.map((l) => [l.lineId, l]));
  const outstanding = Object.fromEntries(
    po.deliveryProgress.lines.map((l) => [l.lineId, l.outstanding]),
  );
  const lineLabel = (lineId: string | null) =>
    po.lines.find((l) => l.lineId === lineId)?.specification ?? 'whole delivery';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/procurement?tab=orders" className="underline">
            Purchase orders
          </Link>
        }
        title={`${po.number} · ${po.supplierName ?? 'supplier'}`}
        description={`${organizationName} · delivery ${humanize(po.deliveryProgress.status)}`}
        actions={
          <>
            <StatusBadge
              status={
                po.status === 'issued'
                  ? 'issued'
                  : po.status === 'delivered' || po.status === 'closed'
                    ? 'completed'
                    : po.status
              }
              label={humanize(po.status)}
            />
            {canManage && po.status === 'draft' ? (
              <ApiAction
                path={`/api/v1/purchase-orders/${po.id}/issue`}
                body={{ expectedVersion: po.version }}
                idempotent
                label="Issue to supplier"
                variant="primary"
                confirm={{
                  title: `Issue ${po.number}?`,
                  description:
                    'The supplier is notified and can acknowledge it. Lines and prices are frozen.',
                  confirmLabel: 'Issue',
                }}
                successMessage="Purchase order issued"
              />
            ) : null}
            {canManage && ['issued', 'acknowledged', 'partially_delivered'].includes(po.status) ? (
              <RecordDelivery poId={po.id} lines={po.lines} outstanding={outstanding} />
            ) : null}
            {canManage && ['draft', 'issued', 'acknowledged'].includes(po.status) ? (
              <ApiAction
                path={`/api/v1/purchase-orders/${po.id}/cancel`}
                body={{ expectedVersion: po.version }}
                reasonKey="reason"
                label="Cancel"
                variant="ghost"
                confirm={{
                  title: 'Cancel this purchase order?',
                  requireReason: true,
                  confirmLabel: 'Cancel order',
                  tone: 'danger',
                }}
                successMessage="Purchase order cancelled"
              />
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Section title="Lines and delivery progress">
          <DataTable
            caption="Purchase order lines"
            rows={po.lines}
            rowKey={(l) => l.lineId}
            rowLabel={(l) => l.specification}
            columns={[
              {
                key: 'spec',
                header: 'Item',
                cell: (l) => (
                  <span>
                    {l.specification}
                    <span className="block text-xs text-fg-muted">{humanize(l.material)}</span>
                  </span>
                ),
              },
              { key: 'qty', header: 'Ordered', cell: (l) => `${l.quantity} ${l.unit}` },
              {
                key: 'price',
                header: 'Price',
                cell: (l) => (
                  <span>
                    <Money kobo={l.unitPriceKobo} currency={po.currency} /> / {l.supplierUnit}
                    {l.conversion ? (
                      <span className="block text-xs text-fg-muted">
                        1 {l.conversion.fromUnit} = {l.conversion.factor} {l.conversion.toUnit} (
                        {humanize(l.conversion.basis)})
                      </span>
                    ) : null}
                  </span>
                ),
                hideOnMobile: true,
              },
              {
                key: 'total',
                header: 'Line total',
                cell: (l) => <Money kobo={l.lineTotalKobo} currency={po.currency} />,
              },
              {
                key: 'recv',
                header: 'Received',
                cell: (l) => {
                  const p = progress.get(l.lineId);
                  if (!p) return '—';
                  return (
                    <span>
                      {p.received} / {p.ordered}{' '}
                      <Badge
                        tone={
                          p.status === 'complete'
                            ? 'success'
                            : p.status === 'over'
                              ? 'danger'
                              : p.status === 'short'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {humanize(p.status)}
                      </Badge>
                      {p.outstandingValueKobo && p.outstandingValueKobo !== '0' ? (
                        <span className="block text-xs text-fg-muted">
                          outstanding value{' '}
                          <Money kobo={p.outstandingValueKobo} currency={po.currency} />
                        </span>
                      ) : null}
                    </span>
                  );
                },
              },
            ]}
          />
        </Section>
        <Section title="Order">
          <DefinitionList
            items={[
              {
                term: 'Goods + delivery',
                value: (
                  <span>
                    <Money kobo={po.totalKobo} currency={po.currency} />{' '}
                    <span className="text-xs text-fg-muted">
                      (delivery <Money kobo={po.deliveryKobo} currency={po.currency} />)
                    </span>
                  </span>
                ),
              },
              {
                term: 'RFQ',
                value: po.rfqId ? (
                  <Link href={`/admin/procurement/rfqs/${po.rfqId}`} className="underline">
                    open RFQ
                  </Link>
                ) : null,
              },
              { term: 'Supplier reference', value: po.supplierRef },
              { term: 'Issued', value: po.issuedAt ? formatDateTimeLabel(po.issuedAt) : null },
              {
                term: 'Expected delivery',
                value: po.expectedDeliveryAt ? formatDateTimeLabel(po.expectedDeliveryAt) : null,
              },
              {
                term: 'Project',
                value: po.projectId ? (
                  <Link href={`/admin/projects/${po.projectId}`} className="underline">
                    open project
                  </Link>
                ) : null,
              },
            ]}
          />
        </Section>
      </div>
      <Section
        title={`Deliveries (${deliveries.length})`}
        description="Accept a delivery once counted and checked. Discrepancies move open → supplier notified → resolved, credited or returned, each with a resolution note."
      >
        {deliveries.length === 0 ? <p className="text-fg-muted">Nothing delivered yet.</p> : null}
        <ul className="space-y-3">
          {deliveries.map((d) => (
            <li key={d.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {d.deliveredAt ? formatDateTimeLabel(d.deliveredAt) : 'undated'}{' '}
                  <Badge>{humanize(d.status)}</Badge>
                </span>
                {canManage ? (
                  <span className="flex flex-wrap gap-1">
                    {['received', 'pending'].includes(d.status) ? (
                      <ApiAction
                        path={`/api/v1/deliveries/${d.id}/accept`}
                        label="Accept delivery"
                        variant="primary"
                        confirm={{
                          title: 'Accept this delivery?',
                          description: 'Confirms the goods were counted and checked.',
                          confirmLabel: 'Accept',
                        }}
                        successMessage="Delivery accepted"
                      />
                    ) : null}
                    {d.status !== 'accepted' ? (
                      <FormDialog
                        trigger="Open discrepancy"
                        title="Open a discrepancy"
                        path={`/api/v1/deliveries/${d.id}/discrepancies`}
                        successMessage="Discrepancy opened"
                        fields={[
                          {
                            name: 'lineId',
                            label: 'Line',
                            type: 'select',
                            options: po.lines.map((l) => ({
                              value: l.lineId,
                              label: l.specification,
                            })),
                            emptyAs: 'null',
                          },
                          {
                            name: 'kind',
                            label: 'Kind',
                            type: 'select',
                            required: true,
                            options: discrepancyKindSchema.options.map((k) => ({
                              value: k,
                              label: humanize(k),
                            })),
                          },
                          {
                            name: 'quantity',
                            label: 'Quantity affected',
                            placeholder: 'e.g. 12',
                            emptyAs: 'null',
                          },
                          {
                            name: 'description',
                            label: 'What is wrong',
                            type: 'textarea',
                            required: true,
                          },
                        ]}
                      />
                    ) : null}
                  </span>
                ) : null}
              </div>
              <ul className="mt-1 text-sm">
                {d.lines.map((l) => (
                  <li key={l.lineId}>
                    {lineLabel(l.lineId)}: {l.quantityReceived}
                    {l.note ? <span className="text-fg-muted"> · {l.note}</span> : null}
                  </li>
                ))}
              </ul>
              {d.note ? <p className="text-xs text-fg-muted">{d.note}</p> : null}
              {d.discrepancies.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {d.discrepancies.map((x) => (
                    <li key={x.id} className="rounded-md bg-bg-sunken p-2 text-sm">
                      <span className="font-medium">{humanize(x.kind)}</span> ·{' '}
                      {lineLabel(x.lineId)} {x.quantity ? `· ${x.quantity}` : ''}{' '}
                      <Badge
                        tone={
                          ['resolved', 'credited', 'returned'].includes(x.status)
                            ? 'success'
                            : 'warning'
                        }
                      >
                        {humanize(x.status)}
                      </Badge>
                      <p className="text-fg-muted">{x.description}</p>
                      {x.resolution ? <p>Resolution: {x.resolution}</p> : null}
                      {canManage && DISCREPANCY_NEXT[x.status] ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {DISCREPANCY_NEXT[x.status]!.map((to) =>
                            to === 'supplier_notified' ? (
                              <ApiAction
                                key={to}
                                path={`/api/v1/deliveries/${d.id}/discrepancies/${x.id}/transition`}
                                body={{ to }}
                                label="Supplier notified"
                                successMessage="Marked supplier notified"
                              />
                            ) : (
                              <ApiAction
                                key={to}
                                path={`/api/v1/deliveries/${d.id}/discrepancies/${x.id}/transition`}
                                body={{ to }}
                                reasonKey="resolution"
                                label={humanize(to)}
                                confirm={{
                                  title: `Mark ${humanize(to).toLowerCase()}?`,
                                  requireReason: true,
                                  reasonLabel: 'Resolution note',
                                  confirmLabel: humanize(to),
                                }}
                                successMessage={`Discrepancy ${humanize(to).toLowerCase()}`}
                              />
                            ),
                          )}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

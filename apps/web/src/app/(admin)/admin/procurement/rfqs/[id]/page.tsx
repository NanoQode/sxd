import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { rfqWorkspace } from '@/lib/admin/server/procurement';
import { ApiAction } from '@/components/admin/api-action';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList } from '../../../_components/bits';
import { CreatePurchaseOrder, type UnconvertedLine } from './_components/create-po';
import { IssueRfq } from './_components/issue-rfq';
import { RecordResponse } from './_components/record-response';

export const metadata: Metadata = { title: 'RFQ' };
export const dynamic = 'force-dynamic';

export default async function RfqPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/procurement');
  const { id } = await params;
  const loaded = await attempt(() => rfqWorkspace(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This RFQ" />;
  }
  const w = loaded.value;
  const r = w.rfq;
  const itemsById = new Map(r.items.map((i) => [i.id, i]));
  const supplierOptions = w.suppliers.map((s) => ({
    userId: s.userId,
    name: s.name,
    partnerType: s.partnerType,
    verificationStatus: s.verificationStatus,
  }));
  const canRespond = w.canManage && r.status === 'sent';
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/procurement" className="underline">
            Procurement
          </Link>
        }
        title={`${r.reference} · ${r.title}`}
        description={`${w.organizationName}${r.deadlineAt ? ` · responses due ${formatDateTimeLabel(r.deadlineAt)}` : ''}`}
        actions={
          <>
            <StatusBadge
              status={
                r.status === 'sent' ? 'published' : r.status === 'awarded' ? 'completed' : r.status
              }
              label={humanize(r.status)}
            />
            {w.canManage && r.status === 'draft' ? (
              <IssueRfq rfqId={r.id} mode="issue" suppliers={supplierOptions} />
            ) : null}
            {w.canManage && r.status === 'sent' ? (
              <IssueRfq rfqId={r.id} mode="invite" suppliers={supplierOptions} />
            ) : null}
            {canRespond ? (
              <RecordResponse
                rfqId={r.id}
                items={r.items}
                suppliers={w.suppliers.map((s) => ({ userId: s.userId, name: s.name }))}
              />
            ) : null}
            {w.canManage && r.status === 'sent' ? (
              <ApiAction
                path={`/api/v1/rfqs/${r.id}/close`}
                label="Close responses"
                confirm={{
                  title: 'Close this RFQ?',
                  description: 'No further responses are accepted.',
                  confirmLabel: 'Close',
                }}
                successMessage="RFQ closed"
              />
            ) : null}
            {w.canManage && ['draft', 'sent'].includes(r.status) ? (
              <ApiAction
                path={`/api/v1/rfqs/${r.id}/cancel`}
                reasonKey="reason"
                label="Cancel"
                variant="ghost"
                confirm={{
                  title: 'Cancel this RFQ?',
                  requireReason: true,
                  confirmLabel: 'Cancel RFQ',
                  tone: 'danger',
                }}
                successMessage="RFQ cancelled"
              />
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Section
          title={`Items (${r.items.length})`}
          description="Quantities are in the buyer's units; comparisons normalise supplier prices to these units."
        >
          <DataTable
            caption="RFQ items"
            rows={r.items}
            rowKey={(i) => i.id}
            rowLabel={(i) => i.specification}
            columns={[
              { key: 'm', header: 'Material', cell: (i) => humanize(i.material) },
              { key: 's', header: 'Specification', cell: (i) => i.specification },
              { key: 'q', header: 'Quantity', cell: (i) => `${i.quantity} ${i.unit}` },
            ]}
          />
        </Section>
        <Section title="Details">
          <DefinitionList
            items={[
              {
                term: 'Organisation',
                value: (
                  <Link href={`/admin/customers/${r.organizationId}`} className="underline">
                    {w.organizationName}
                  </Link>
                ),
              },
              {
                term: 'Project',
                value: r.projectId ? (
                  <Link href={`/admin/projects/${r.projectId}`} className="underline">
                    open project
                  </Link>
                ) : null,
              },
              { term: 'Delivery market', value: r.deliveryMarketName },
              {
                term: 'Delivery address',
                value: r.deliveryAddress
                  ? Object.values(r.deliveryAddress).filter(Boolean).join(', ')
                  : null,
              },
              { term: 'Created by', value: w.createdByName },
              { term: 'Notes', value: r.notes },
            ]}
          />
        </Section>
      </div>

      <Section
        title="Delivered-cost comparison"
        description="Goods plus delivery in the RFQ's units. A line priced in another unit without a declared conversion is shown as unknown, never estimated; such a response is not ranked."
      >
        {!w.comparison.ok ? (
          <LoadError
            code={w.comparison.code}
            message={w.comparison.message}
            what="The comparison"
          />
        ) : w.comparison.value.entries.length === 0 ? (
          <p className="text-fg-muted">No submitted responses yet.</p>
        ) : (
          <>
            <p className="text-xs text-fg-muted">{w.comparison.value.note}</p>
            <ul className="space-y-3">
              {[...w.comparison.value.entries]
                .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
                .map((e) => {
                  const response = r.responses.find((x) => x.id === e.responseId);
                  const unconverted: UnconvertedLine[] = e.lines
                    .filter(
                      (l) =>
                        !l.comparable &&
                        !l.conversion &&
                        l.supplierUnit &&
                        l.supplierUnit !== l.rfqUnit,
                    )
                    .map((l) => ({
                      itemId: l.itemId,
                      label: itemsById.get(l.itemId)?.specification ?? 'item',
                      supplierUnit: l.supplierUnit!,
                      rfqUnit: l.rfqUnit,
                    }));
                  return (
                    <li key={e.responseId} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {e.rank ? (
                            <Badge tone="primary">#{e.rank}</Badge>
                          ) : (
                            <Badge>not ranked</Badge>
                          )}{' '}
                          {e.supplierLabel}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          Goods <Money kobo={e.goodsKobo} /> + delivery{' '}
                          <Money kobo={e.deliveryKobo} /> ={' '}
                          <strong>
                            {e.totalDeliveredKobo ? (
                              <Money kobo={e.totalDeliveredKobo} />
                            ) : (
                              <span className="text-warning">unknown</span>
                            )}
                          </strong>
                          {w.canManage &&
                          response &&
                          ['submitted', 'selected'].includes(response.status) &&
                          r.status !== 'cancelled' ? (
                            <CreatePurchaseOrder
                              responseId={e.responseId}
                              supplierLabel={e.supplierLabel}
                              unconverted={unconverted}
                            />
                          ) : null}
                        </span>
                      </div>
                      <p className="text-xs text-fg-muted">
                        {e.comparableLines}/{e.totalLines} lines comparable · lead time{' '}
                        {e.leadTimeDays ?? '—'} days · valid until{' '}
                        {e.validUntil ? formatDateTimeLabel(e.validUntil) : '—'}
                      </p>
                      {e.unknowns.length > 0 ? (
                        <Alert tone="warning" title="Unknowns" className="mt-2">
                          <ul className="list-disc pl-4">
                            {e.unknowns.map((u, n) => (
                              <li key={n}>
                                {u.itemId
                                  ? `${itemsById.get(u.itemId)?.specification ?? 'item'}: `
                                  : ''}
                                {u.message}
                              </li>
                            ))}
                          </ul>
                        </Alert>
                      ) : null}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm">Line detail</summary>
                        <div className="overflow-x-auto">
                          <table className="mt-1 w-full min-w-[560px] text-left text-xs">
                            <caption className="sr-only">Line detail for {e.supplierLabel}</caption>
                            <thead>
                              <tr className="text-fg-muted">
                                <th scope="col" className="py-1 pr-2">
                                  Item
                                </th>
                                <th scope="col" className="py-1 pr-2">
                                  Supplier price
                                </th>
                                <th scope="col" className="py-1 pr-2">
                                  Conversion
                                </th>
                                <th scope="col" className="py-1 pr-2">
                                  Per RFQ unit
                                </th>
                                <th scope="col" className="py-1">
                                  Line total
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.lines.map((l) => (
                                <tr key={l.itemId} className="border-t border-border">
                                  <td className="py-1 pr-2">
                                    {itemsById.get(l.itemId)?.specification ?? l.itemId}
                                  </td>
                                  <td className="py-1 pr-2">
                                    <Money kobo={l.supplierUnitPriceKobo} /> /{' '}
                                    {l.supplierUnit ?? '—'}
                                  </td>
                                  <td className="py-1 pr-2">
                                    {l.conversion
                                      ? `1 ${l.conversion.fromUnit} = ${l.conversion.factor} ${l.conversion.toUnit} (${humanize(l.conversion.basis)})`
                                      : l.supplierUnit === l.rfqUnit
                                        ? 'same unit'
                                        : 'none declared'}
                                  </td>
                                  <td className="py-1 pr-2">
                                    <Money kobo={l.normalizedUnitPriceKobo} /> / {l.rfqUnit}
                                  </td>
                                  <td className="py-1">
                                    {l.comparable ? (
                                      <Money kobo={l.lineTotalKobo} />
                                    ) : (
                                      <span className="text-warning">{l.message ?? 'unknown'}</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </li>
                  );
                })}
            </ul>
          </>
        )}
      </Section>

      <Section title={`Responses (${r.responses.length})`}>
        <DataTable
          caption="Responses"
          rows={r.responses}
          rowKey={(x) => x.id}
          rowLabel={(x) => x.supplierName ?? x.supplierUserId ?? 'response'}
          emptyMessage="No responses."
          columns={[
            {
              key: 's',
              header: 'Supplier',
              cell: (x) =>
                x.supplierName ??
                w.suppliers.find((s) => s.userId === x.supplierUserId)?.name ??
                x.supplierUserId ??
                '—',
            },
            { key: 'st', header: 'Status', cell: (x) => humanize(x.status) },
            {
              key: 't',
              header: 'Delivered total',
              cell: (x) => <Money kobo={x.totalDeliveredKobo} currency={x.currency} />,
            },
            {
              key: 'sub',
              header: 'Submitted',
              cell: (x) => (x.submittedAt ? formatDateTimeLabel(x.submittedAt) : '—'),
              hideOnMobile: true,
            },
          ]}
        />
      </Section>

      <Section title={`Purchase orders (${w.orders.length})`}>
        {w.orders.length === 0 ? (
          <p className="text-fg-muted">No purchase orders from this RFQ.</p>
        ) : (
          <ul className="space-y-1">
            {w.orders.map((po) => (
              <li key={po.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/admin/procurement/purchase-orders/${po.id}`} className="underline">
                  {po.number} · {po.supplierName ?? 'supplier'}
                </Link>
                <span className="flex items-center gap-2">
                  <Money kobo={po.totalKobo} currency={po.currency} />
                  <Badge>{humanize(po.status)}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

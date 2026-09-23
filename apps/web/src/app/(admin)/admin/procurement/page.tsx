import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { deliveryStatusSchema, procurementMaterialSchema, purchaseOrderStatusSchema, rfqStatusSchema, type DeliveryDto, type PurchaseOrderListQuery, type RfqListQuery } from '@simplexd/contracts';
import { Alert, Badge, DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listDeliveriesView, listPurchaseOrdersView, listRfqsView, supplierDirectory } from '@/lib/admin/server/procurement';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { TabLink, TabNav } from '@/components/admin/section';
import { RfqCreateDialog } from './_components/rfq-create-dialog';

export const metadata: Metadata = { title: 'Procurement' };
export const dynamic = 'force-dynamic';

type Tab = 'rfqs' | 'orders' | 'deliveries' | 'suppliers';

export default async function ProcurementPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireSignedIn('/admin/procurement');
  const raw = await searchParams;
  const tab: Tab = raw.tab === 'orders' || raw.tab === 'deliveries' || raw.tab === 'suppliers' ? raw.tab : 'rfqs';
  const orgs = await attempt(() => searchOrganizations(identity, undefined, 500));
  const organizations = orgs.ok ? orgs.value : [];
  const cursor = raw.cursor || undefined;
  const next = (c: string | null) => {
    if (!c) return null;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) if (v && k !== 'cursor') p.set(k, v);
    p.set('cursor', c);
    return `/admin/procurement?${p.toString()}`;
  };
  const tabHref = (t: Tab) => (t === 'rfqs' ? '/admin/procurement' : `/admin/procurement?tab=${t}`);

  let body: ReactNode = null;
  if (tab === 'rfqs') {
    const status = rfqStatusSchema.safeParse(raw.status).success ? (raw.status as RfqListQuery['status']) : undefined;
    const res = await attempt(() => listRfqsView(identity, { status, organizationId: raw.organizationId || undefined, cursor, limit: 50 }));
    body = !res.ok ? (
      <LoadError code={res.code} message={res.message} what="Procurement" />
    ) : (
      <>
        <FilterBar hidden={{ tab: raw.tab }}>
          <FilterSelect name="status" label="Status" value={status} options={rfqStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
          <FilterSelect name="organizationId" label="Organisation" value={raw.organizationId} allLabel="All" options={organizations.map((o) => ({ value: o.id, label: o.name }))} />
        </FilterBar>
        <DataTable
          caption="Requests for quotation"
          rows={res.value.items}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.reference}
          emptyMessage="No RFQs in this view."
          columns={[
            { key: 'ref', header: 'RFQ', cell: (r) => <span><Link href={`/admin/procurement/rfqs/${r.id}`} className="font-medium text-primary underline">{r.reference}</Link><span className="block text-xs text-fg-muted">{r.title}</span></span> },
            { key: 'org', header: 'Organisation', cell: (r) => r.organizationName, hideOnMobile: true },
            { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status === 'sent' ? 'published' : r.status === 'awarded' ? 'completed' : r.status} label={humanize(r.status)} /> },
            { key: 'dl', header: 'Deadline', cell: (r) => (r.deadlineAt ? formatDateTimeLabel(r.deadlineAt) : '—') },
            { key: 'mk', header: 'Delivery to', cell: (r) => r.deliveryMarketName ?? (r.deliveryAddress ? Object.values(r.deliveryAddress).filter(Boolean).join(', ') : '—'), hideOnMobile: true },
          ]}
        />
        {next(res.value.nextCursor) ? <Link href={next(res.value.nextCursor)!} className="text-sm underline">Next page</Link> : null}
      </>
    );
  } else if (tab === 'orders') {
    const status = purchaseOrderStatusSchema.safeParse(raw.status).success ? (raw.status as PurchaseOrderListQuery['status']) : undefined;
    const res = await attempt(() => listPurchaseOrdersView(identity, { status, organizationId: raw.organizationId || undefined, cursor, limit: 50 }));
    body = !res.ok ? (
      <LoadError code={res.code} message={res.message} what="Purchase orders" />
    ) : (
      <>
        <FilterBar hidden={{ tab: raw.tab }}>
          <FilterSelect name="status" label="Status" value={status} options={purchaseOrderStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
          <FilterSelect name="organizationId" label="Organisation" value={raw.organizationId} allLabel="All" options={organizations.map((o) => ({ value: o.id, label: o.name }))} />
        </FilterBar>
        <div className="flex justify-end">
          <ExportCsvButton
            rows={res.value.items}
            filename="purchase-orders.csv"
            columns={[
              { header: 'Number', value: (p) => p.number },
              { header: 'Organisation', value: (p) => p.organizationName },
              { header: 'Supplier', value: (p) => p.supplierName },
              { header: 'Status', value: (p) => p.status },
              { header: 'Total kobo', value: (p) => p.totalKobo },
              { header: 'Currency', value: (p) => p.currency },
              { header: 'Issued at', value: (p) => p.issuedAt },
            ]}
          />
        </div>
        <DataTable
          caption="Purchase orders"
          rows={res.value.items}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.number}
          emptyMessage="No purchase orders in this view."
          columns={[
            { key: 'n', header: 'Order', cell: (p) => <Link href={`/admin/procurement/purchase-orders/${p.id}`} className="font-medium text-primary underline">{p.number}</Link> },
            { key: 'sup', header: 'Supplier', cell: (p) => p.supplierName ?? '—' },
            { key: 'org', header: 'Organisation', cell: (p) => p.organizationName, hideOnMobile: true },
            { key: 'st', header: 'Status', cell: (p) => humanize(p.status) },
            { key: 'tot', header: 'Total', cell: (p) => <Money kobo={p.totalKobo} currency={p.currency} /> },
            { key: 'exp', header: 'Expected', cell: (p) => (p.expectedDeliveryAt ? formatDateTimeLabel(p.expectedDeliveryAt) : '—'), hideOnMobile: true },
          ]}
        />
        {next(res.value.nextCursor) ? <Link href={next(res.value.nextCursor)!} className="text-sm underline">Next page</Link> : null}
      </>
    );
  } else if (tab === 'deliveries') {
    const status = deliveryStatusSchema.safeParse(raw.status).success ? (raw.status as DeliveryDto['status']) : undefined;
    const res = await attempt(() => listDeliveriesView(identity, { status, cursor, limit: 50 }));
    body = !res.ok ? (
      <LoadError code={res.code} message={res.message} what="Deliveries" />
    ) : (
      <>
        <FilterBar hidden={{ tab: raw.tab }}>
          <FilterSelect name="status" label="Status" value={status} options={deliveryStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
        </FilterBar>
        <DataTable
          caption="Deliveries"
          rows={res.value.items}
          rowKey={(d) => d.id}
          rowLabel={(d) => d.purchaseOrderNumber}
          emptyMessage="No deliveries in this view."
          columns={[
            { key: 'po', header: 'Order', cell: (d) => <Link href={`/admin/procurement/purchase-orders/${d.purchaseOrderId}`} className="underline">{d.purchaseOrderNumber}</Link> },
            { key: 'at', header: 'Delivered', cell: (d) => (d.deliveredAt ? formatDateTimeLabel(d.deliveredAt) : '—') },
            { key: 'st', header: 'Status', cell: (d) => humanize(d.status) },
            { key: 'disc', header: 'Discrepancies', cell: (d) => { const open = d.discrepancies.filter((x) => ['open', 'supplier_notified'].includes(x.status)).length; return open ? <Badge tone="warning">{open} open</Badge> : d.discrepancies.length ? `${d.discrepancies.length} closed` : 'none'; } },
          ]}
        />
        {next(res.value.nextCursor) ? <Link href={next(res.value.nextCursor)!} className="text-sm underline">Next page</Link> : null}
      </>
    );
  } else {
    const material = procurementMaterialSchema.safeParse(raw.material).success ? raw.material : undefined;
    const res = await attempt(() => supplierDirectory(identity, { material }));
    body = !res.ok ? (
      <LoadError code={res.code} message={res.message} what="The supplier directory" />
    ) : (
      <>
        <Alert tone="info" title="What this directory is">
          {res.value.note}
        </Alert>
        <FilterBar hidden={{ tab: raw.tab }}>
          <FilterSelect name="material" label="Material" value={material} options={procurementMaterialSchema.options.map((m) => ({ value: m, label: humanize(m) }))} />
        </FilterBar>
        <DataTable
          caption="Supplier directory"
          rows={res.value.items}
          rowKey={(s) => s.facilityId}
          rowLabel={(s) => s.name}
          emptyMessage="No facilities match."
          columns={[
            { key: 'n', header: 'Facility', cell: (s) => <span>{s.name}<span className="block text-xs text-fg-muted">{s.operator ?? ''}{s.stateName ? ` · ${s.stateName}` : ''}</span></span> },
            { key: 'm', header: 'Material', cell: (s) => humanize(s.material) },
            { key: 'e', header: 'Evidence', cell: (s) => <span>{s.evidenceLabel}{s.deliveryCoverageVerified ? <Badge tone="success" className="ml-1">coverage verified</Badge> : null}</span> },
            { key: 'p', header: 'Price evidence', cell: (s) => humanize(s.priceEvidence) },
            { key: 'c', header: 'Coverage', cell: (s) => (s.coverage.length ? s.coverage.map((c) => `${c.marketName ?? 'market'} (${c.relationLabel})`).join(', ') : 'none recorded'), hideOnMobile: true },
            { key: 'contact', header: 'Contact permitted', cell: (s) => (s.contactPermission ? 'yes' : 'no'), hideOnMobile: true },
          ]}
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Procurement"
        description="Requests for quotation, delivered-cost comparisons in normalised units, purchase orders, deliveries and discrepancies. An unknown unit conversion stays unknown; it is never estimated."
        actions={can(identity, 'procurement.manage') && tab === 'rfqs' ? <RfqCreateDialog organizations={organizations} /> : undefined}
      />
      <TabNav label="Procurement views">
        <TabLink href={tabHref('rfqs')} active={tab === 'rfqs'}>RFQs</TabLink>
        <TabLink href={tabHref('orders')} active={tab === 'orders'}>Purchase orders</TabLink>
        <TabLink href={tabHref('deliveries')} active={tab === 'deliveries'}>Deliveries</TabLink>
        <TabLink href={tabHref('suppliers')} active={tab === 'suppliers'}>Supplier directory</TabLink>
      </TabNav>
      <SavedViewsBar tableKey={`procurement-${tab}`} />
      {body}
    </div>
  );
}

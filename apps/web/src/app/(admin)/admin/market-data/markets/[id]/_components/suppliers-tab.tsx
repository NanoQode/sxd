import { Alert, Badge, DataTable, formatNairaString, type Column } from '@simplexd/ui';
import type { SupplierLeadDto, SupplierQuoteDto } from '@/server/admin/market-data/suppliers';
import { humanize } from '../../../_lib/params';

/** Read-only view of editorial supplier leads and recorded quotes (server-safe). */
export function SuppliersTab({ leads, quotes }: { leads: SupplierLeadDto[]; quotes: SupplierQuoteDto[] }) {
  const leadColumns: Column<SupplierLeadDto>[] = [
    { key: 'name', header: 'Facility', cell: (l) => <span className="font-medium">{l.name}<span className="block text-xs text-fg-muted">{l.operator ?? ''}{l.stateName ? ` · ${l.stateName}` : ''}</span></span> },
    { key: 'material', header: 'Material', cell: (l) => humanize(l.material) },
    { key: 'evidence', header: 'Evidence', cell: (l) => <Badge tone={l.evidenceStatus === 'verified_supplier' ? 'success' : 'neutral'}>{humanize(l.evidenceStatus)}</Badge> },
    { key: 'relation', header: 'Relation', cell: (l) => <span className="text-xs">{humanize(l.relation)}{l.deliveryCoverageVerified ? ' · delivery verified' : ' · delivery unverified'}</span> },
    { key: 'stock', header: 'Stock', cell: (l) => humanize(l.stockStatus) },
    { key: 'source', header: 'Source', hideOnMobile: true, cell: (l) => <span className="text-xs text-fg-muted">{l.sourceTitle ?? '—'}</span> },
  ];
  const quoteColumns: Column<SupplierQuoteDto>[] = [
    { key: 'material', header: 'Material', cell: (q) => <span className="font-medium">{humanize(q.material)}<span className="block text-xs text-fg-muted">{q.specification}</span></span> },
    { key: 'supplier', header: 'Supplier', cell: (q) => q.supplierName ?? q.facilityName ?? '—' },
    { key: 'price', header: 'Unit price', cell: (q) => (q.unitPriceKobo ? `${formatNairaString(q.unitPriceKobo)} / ${q.unit}` : '—') },
    { key: 'delivery', header: 'Delivery', cell: (q) => (q.deliveryCostKobo ? formatNairaString(q.deliveryCostKobo) : '—') },
    { key: 'lead', header: 'Lead time', cell: (q) => (q.leadTimeDays === null ? '—' : `${q.leadTimeDays} days`) },
    { key: 'quoted', header: 'Quoted', cell: (q) => <span className="text-xs">{q.quotedAt}{q.validUntil ? ` → ${q.validUntil}` : ''}</span> },
    { key: 'status', header: 'Review', cell: (q) => <Badge tone={q.reviewStatus === 'verified' ? 'success' : 'neutral'}>{humanize(q.reviewStatus === 'source_read_pending_business_review' ? 'pending review' : q.reviewStatus)}</Badge> },
  ];
  return (
    <div className="space-y-6">
      <Alert tone="info" title="Leads are not delivery promises">
        Facility links are editorial research leads, not verified distribution routes, dealer appointments or stock reports. Delivered quotes with specification, taxes, freight and validity are what make materials comparable.
      </Alert>
      <h2 className="text-lg font-semibold">Supplier leads</h2>
      <DataTable columns={leadColumns} rows={leads} rowKey={(l) => l.coverageId} rowLabel={(l) => l.name} caption="Supplier leads" emptyMessage="No supplier leads linked to this market." />
      <h2 className="text-lg font-semibold">Quotes</h2>
      <DataTable columns={quoteColumns} rows={quotes} rowKey={(q) => q.id} rowLabel={(q) => `${q.material} ${q.specification}`} caption="Supplier quotes" emptyMessage="No delivered quotes recorded. Quotes are collected through the procurement workflow (wave 4) or research tasks." />
    </div>
  );
}

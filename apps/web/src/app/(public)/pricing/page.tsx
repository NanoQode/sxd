import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, buttonVariants, DataTable, EmptyState, formatDateLabel, PageHeader, StatusBadge, type Column } from '@simplexd/ui';
import { Breadcrumbs } from '@/components/public/breadcrumbs';
import { CtaBand } from '@/components/public/cta-band';
import { basisLabel, priceStatusLabel } from '@/components/public/price-anchor';
import type { ServiceCatalogItem, ServicePackageView } from '@/server/services/catalog';
import { loadCatalog, publicMetadata, siteUrl } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'Pricing',
  description:
    'Indicative price anchors for the eight SimplexD services with basis, minimum scope, exclusions, effective date and publication status. Final pricing is a scoped quotation.',
  path: '/pricing',
});

interface Row {
  service: ServiceCatalogItem;
  pkg: ServicePackageView;
}

export default async function PricingPage() {
  const catalog = await loadCatalog();
  const rows: Row[] = (catalog?.core ?? []).flatMap((service) =>
    service.packages.map((pkg) => ({ service, pkg })),
  );
  const underReview = rows.filter((r) => r.pkg.publicationState === 'in_review').length;

  const columns: Column<Row>[] = [
    {
      key: 'service',
      header: 'Service',
      cell: (r) => (
        <Link href={`/services/${r.service.slug}`} className="font-medium text-primary underline">
          {r.service.name}
        </Link>
      ),
    },
    { key: 'package', header: 'Package', cell: (r) => r.pkg.name },
    {
      key: 'anchor',
      header: 'Price anchor',
      cell: (r) => <span className="font-medium">{r.pkg.priceLabel ?? 'Not published'}</span>,
    },
    { key: 'basis', header: 'Basis', cell: (r) => basisLabel(r.pkg.priceBasis) },
    { key: 'scope', header: 'Minimum scope', cell: (r) => r.pkg.minimumScope ?? '—' },
    { key: 'exclusions', header: 'Exclusions', cell: (r) => r.pkg.exclusions ?? '—' },
    {
      key: 'effective',
      header: 'Effective',
      cell: (r) =>
        r.pkg.effectiveFrom
          ? `${formatDateLabel(r.pkg.effectiveFrom)}${r.pkg.effectiveTo ? ` – ${formatDateLabel(r.pkg.effectiveTo)}` : ''}`
          : 'Not set',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <StatusBadge status={r.pkg.publicationState} label={priceStatusLabel(r.pkg.publicationState)} />
      ),
    },
  ];

  return (
    <>
      <Breadcrumbs items={[{ name: 'Pricing', href: '/pricing' }]} baseUrl={siteUrl()} />
      <div className="sx-container space-y-6 py-6">
        <PageHeader
          eyebrow="Pricing"
          title="Price anchors with their basis"
          description="Anchors are editable business data, not universally fixed fees. Each row states the basis, minimum scope, exclusions and effective date. Your engagement is priced by a scoped quotation after triage."
          actions={
            <Link href="/book" className={buttonVariants()}>
              Request a quotation
            </Link>
          }
        />
        {underReview > 0 ? (
          <Alert tone="info" title={`${underReview} anchor${underReview > 1 ? 's are' : ' is'} under business review`}>
            Rows marked “Under business review” show the label instead of a figure until the business
            approves publication. No number is shown before that review.
          </Alert>
        ) : null}
        <Alert tone="warning" title="Percentage fees">
          Purchase representation is priced as a percentage of the purchase price. It is never
          calculated without an agreed percentage basis and a signed scope.
        </Alert>
        {rows.length > 0 ? (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.pkg.id}
            rowLabel={(r) => `${r.service.name} – ${r.pkg.name}`}
            caption="Price anchors for the eight core services"
          />
        ) : (
          <EmptyState
            tone={catalog ? 'neutral' : 'warning'}
            title={catalog ? 'No price anchors are published yet' : 'Pricing is not available right now'}
            description={
              catalog
                ? 'Anchors appear here once packages are created and reviewed by the business.'
                : 'The database did not respond. Consultation requests still work.'
            }
          />
        )}
        <p className="text-xs text-fg-subtle">
          Naira amounts are shown as whole naira; all invoices are issued in NGN. Timestamps in Africa/Lagos.
        </p>
      </div>
      <CtaBand
        title="Need a figure for your own scope?"
        description="Send the property, location and stage; the quotation states scope, exclusions and validity."
        primary={{ label: 'Request a quotation', href: '/book' }}
      />
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { uuidSchema } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, StatusBadge, humanize, type Column } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { priceStatusLabel } from '@/components/public/price-anchor';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { getPriceAnchor, type PriceAnchorRevisionDto } from '@/server/admin/configuration/pricing';
import { fmtDate } from '../../../_components/bits';
import { ValuesSummary, figureLabel } from '../../_components/price-anchors-board';

export const metadata: Metadata = { title: 'Price anchor history' };
export const dynamic = 'force-dynamic';

export default async function PriceAnchorHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/admin/services/pricing/${id}`);
  const loaded = await attempt(() => getPriceAnchor(adminContext(identity), id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="Price anchor" />;
  }
  const a = loaded.value;
  const revisions = a.revisions ?? [];
  const columns: Column<PriceAnchorRevisionDto>[] = [
    { key: 'rev', header: 'Revision', cell: (r) => <span className="font-mono">#{r.revision}</span> },
    { key: 'event', header: 'Event', cell: (r) => <StatusBadge status={r.state} label={humanize(r.event)} /> },
    { key: 'figure', header: 'Figure', cell: (r) => figureLabel(r.values) },
    {
      key: 'effective',
      header: 'Effective from',
      cell: (r) => r.values.effectiveFrom ?? '—',
      hideOnMobile: true,
    },
    { key: 'who', header: 'By', cell: (r) => r.changedBy?.name ?? 'System' },
    { key: 'when', header: 'When', cell: (r) => <span className="text-xs">{fmtDate(r.createdAt)}</span> },
    { key: 'reason', header: 'Reason', cell: (r) => <span className="text-xs text-fg-muted">{r.reason ?? '—'}</span> },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/services" className="underline">
            Price anchors
          </Link>
        }
        title={`${a.serviceName}: ${a.live.name}`}
        description="Append-only revision history. Nothing here is ever edited or deleted; a rejected or withdrawn proposal stays on record."
        actions={<StatusBadge status={a.publicationState} label={priceStatusLabel(a.publicationState)} />}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-bg-elevated p-4">
          <h2 className="mb-2 font-semibold">
            {a.publicationState === 'published' ? 'Live anchor' : 'Stored values (not public)'}
          </h2>
          <ValuesSummary v={a.live} />
          <p className="mt-2 text-xs text-fg-muted">
            Row version {a.version}
            {a.publishedAt ? ` · published ${fmtDate(a.publishedAt)}` : ''}
            {a.reviewedBy ? ` by ${a.reviewedBy.name}` : ''}
          </p>
        </section>
        <section className="rounded-lg border border-border bg-bg-elevated p-4">
          <h2 className="mb-2 font-semibold">Open proposal</h2>
          {a.proposal ? (
            <>
              <Badge tone={a.proposal.state === 'in_review' ? 'warning' : 'neutral'}>
                {a.proposal.state === 'in_review' ? 'Under review' : 'Draft'}
              </Badge>
              <div className="mt-2">
                <ValuesSummary v={a.proposal.values} />
              </div>
              <p className="mt-2 text-xs text-fg-muted">
                {a.proposal.implicit
                  ? 'Seeded anchor awaiting its first business review.'
                  : `Authors: ${a.proposal.authors.map((u) => u.name).join(', ') || 'unknown'}`}
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">None. Propose a change from the price anchors list.</p>
          )}
        </section>
      </div>
      <DataTable
        columns={columns}
        rows={revisions}
        rowKey={(r) => String(r.revision)}
        rowLabel={(r) => `Revision ${r.revision}`}
        caption="Revision history"
        emptyMessage="No revisions yet: this anchor came from the seed and has not been changed or reviewed."
      />
    </div>
  );
}

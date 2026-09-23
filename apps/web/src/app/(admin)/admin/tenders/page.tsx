import type { Metadata } from 'next';
import Link from 'next/link';
import { tenderListQuerySchema, tenderStatusSchema, type TenderListQuery } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { listTendersView } from '@/lib/admin/server/tenders';
import { ExportCsvButton } from '@/components/admin/export-csv-button';
import { FilterBar, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { SavedViewsBar } from '@/components/admin/saved-views-bar';
import { TenderForm } from './_components/tender-form';

export const metadata: Metadata = { title: 'Tenders' };
export const dynamic = 'force-dynamic';

export default async function TendersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const identity = await requireSignedIn('/admin/tenders');
  const raw = await searchParams;
  const status = tenderStatusSchema.safeParse(raw.status).success ? (raw.status as TenderListQuery['status']) : undefined;
  const query = tenderListQuerySchema.parse({ status, organizationId: raw.organizationId || undefined, cursor: raw.cursor || undefined, limit: 50 });
  const [loaded, orgs] = await Promise.all([attempt(() => listTendersView(identity, query)), attempt(() => searchOrganizations(identity, undefined, 500))]);
  if (!loaded.ok) return <LoadError code={loaded.code} message={loaded.message} what="Tenders" />;
  const organizations = orgs.ok ? orgs.value : [];
  const rows = loaded.value.items;
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (v && k !== 'cursor') next.set(k, v);
  if (loaded.value.nextCursor) next.set('cursor', loaded.value.nextCursor);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenders"
        description="Contractor tendering: scope and BOQ, invited partners, clarifications, sealed submissions, weighted evaluation and a published award. Deadlines use the server clock; a late bid cannot be accepted."
        actions={can(identity, 'tenders.manage') ? <TenderForm organizations={organizations} /> : undefined}
      />
      <SavedViewsBar tableKey="tenders" />
      <FilterBar>
        <FilterSelect name="status" label="Status" value={status} options={tenderStatusSchema.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect name="organizationId" label="Organisation" value={raw.organizationId} allLabel="All" options={organizations.map((o) => ({ value: o.id, label: o.name }))} />
      </FilterBar>
      <div className="flex justify-end">
        <ExportCsvButton
          rows={rows}
          filename="tenders.csv"
          columns={[
            { header: 'Reference', value: (t) => t.reference },
            { header: 'Title', value: (t) => t.title },
            { header: 'Organisation', value: (t) => t.organizationName },
            { header: 'Status', value: (t) => t.status },
            { header: 'Sealed', value: (t) => t.sealed },
            { header: 'Effective deadline', value: (t) => t.timeline.effectiveSubmissionDeadlineAt },
            { header: 'Revision', value: (t) => t.currentRevision },
          ]}
        />
      </div>
      <DataTable
        caption="Tenders"
        rows={rows}
        rowKey={(t) => t.id}
        rowLabel={(t) => t.reference}
        emptyMessage="No tenders in this view."
        columns={[
          {
            key: 't',
            header: 'Tender',
            cell: (t) => (
              <span>
                <Link href={`/admin/tenders/${t.id}`} className="font-medium text-primary underline">
                  {t.reference}
                </Link>
                <span className="block text-xs text-fg-muted">{t.title}</span>
              </span>
            ),
          },
          { key: 'org', header: 'Organisation', cell: (t) => t.organizationName, hideOnMobile: true },
          { key: 'proj', header: 'Project', cell: (t) => (t.projectId ? <Link href={`/admin/projects/${t.projectId}`} className="underline">{t.projectName ?? 'project'}</Link> : '—'), hideOnMobile: true },
          { key: 'st', header: 'Status', cell: (t) => <StatusBadge status={t.status === 'evaluating' ? 'in_review' : t.status === 'awarded' ? 'completed' : t.status} label={humanize(t.status)} /> },
          { key: 'sealed', header: 'Bids', cell: (t) => (t.sealed ? <Badge tone="gold">sealed</Badge> : <Badge>open</Badge>) },
          {
            key: 'deadline',
            header: 'Deadline',
            cell: (t) =>
              t.timeline.effectiveSubmissionDeadlineAt ? (
                <span>
                  {formatDateTimeLabel(t.timeline.effectiveSubmissionDeadlineAt, t.displayTimeZone)}
                  {t.timeline.extensionRevision ? <Badge tone="warning" className="ml-1">extended</Badge> : null}
                </span>
              ) : (
                '—'
              ),
          },
        ]}
      />
      {loaded.value.nextCursor ? (
        <Link href={`/admin/tenders?${next.toString()}`} className="text-sm underline">
          Next page
        </Link>
      ) : null}
    </div>
  );
}

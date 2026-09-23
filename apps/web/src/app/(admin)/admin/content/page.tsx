import type { Metadata } from 'next';
import Link from 'next/link';
import { contentKindSchema, contentListQuerySchema, contentStatusSchema } from '@simplexd/contracts';
import { Badge, DataTable, EmptyState, NativeSelect, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listContentPages } from '@/server/content/admin';

export const metadata: Metadata = { title: 'Content' };
export const dynamic = 'force-dynamic';

export default async function ContentListPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; q?: string; cursor?: string }>;
}) {
  const identity = await requireStaffPage('content.edit');
  const raw = await searchParams;
  const query = contentListQuerySchema.parse({
    kind: contentKindSchema.safeParse(raw.kind).success ? raw.kind : undefined,
    status: contentStatusSchema.safeParse(raw.status).success ? raw.status : undefined,
    q: raw.q?.trim() || undefined,
    cursor: raw.cursor,
    limit: 50,
  });
  const page = await listContentPages(identity, query);
  const filterParams = new URLSearchParams();
  if (query.kind) filterParams.set('kind', query.kind);
  if (query.status) filterParams.set('status', query.status);
  if (query.q) filterParams.set('q', query.q);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Content"
        description="Pages, service copy, FAQs, policies, navigation and banners. Draft, review, publish or schedule; every publication is audited and reversible."
        actions={
          <>
            <Link href="/admin/content/redirects" className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm font-medium">
              Redirects
            </Link>
            <Link href="/admin/content/new" className="sx-touch inline-flex items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary">
              New page
            </Link>
          </>
        }
      />
      <form method="get" className="grid gap-3 rounded-lg border border-border bg-bg-elevated p-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Kind</span>
          <NativeSelect name="kind" defaultValue={query.kind ?? ''}>
            <option value="">All kinds</option>
            {contentKindSchema.options.map((k) => (
              <option key={k} value={k}>
                {humanize(k)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Status</span>
          <NativeSelect name="status" defaultValue={query.status ?? ''}>
            <option value="">All statuses</option>
            {contentStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Search</span>
          <input name="q" defaultValue={query.q ?? ''} placeholder="Title or slug" className="h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-sm" />
        </label>
        <button type="submit" className="sx-touch rounded-md border border-border-strong px-4 text-sm font-medium">
          Filter
        </button>
      </form>
      {page.items.length === 0 ? (
        <EmptyState
          title="No pages match"
          description="Adjust the filters or create a page. Starter pages (about, how it works, policies, FAQs, goal paths) are seeded by pnpm db:seed."
        />
      ) : (
        <DataTable
          caption="Content pages"
          rows={page.items}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.title}
          columns={[
            {
              key: 'title',
              header: 'Title',
              cell: (p) => (
                <Link href={`/admin/content/${p.id}`} className="font-medium text-primary underline">
                  {p.title}
                </Link>
              ),
            },
            { key: 'slug', header: 'Slug', cell: (p) => <span className="font-mono text-xs">{p.slug}</span> },
            { key: 'kind', header: 'Kind', cell: (p) => <Badge tone="neutral">{humanize(p.kind)}</Badge> },
            { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
            {
              key: 'revisions',
              header: 'Revisions',
              cell: (p) => (
                <span className="text-xs">
                  current {p.currentRevision}
                  {p.publishedRevision !== null ? ` · live ${p.publishedRevision}` : ''}
                  {p.publishedRevision !== null && p.currentRevision > p.publishedRevision ? ' · unpublished changes' : ''}
                </span>
              ),
            },
            { key: 'publishAt', header: 'Scheduled', cell: (p) => (p.publishAt ? formatDateTimeLabel(p.publishAt) : '—'), hideOnMobile: true },
            { key: 'updated', header: 'Updated', cell: (p) => formatDateTimeLabel(p.updatedAt) },
          ]}
        />
      )}
      {page.nextCursor ? (
        <Link
          href={`/admin/content?${new URLSearchParams({ ...Object.fromEntries(filterParams), cursor: page.nextCursor }).toString()}`}
          className="sx-touch inline-flex items-center rounded-md border border-border-strong px-4 text-sm"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import type { TemplateFamilySummaryDto } from '@simplexd/contracts';
import { Badge, DataTable, PageHeader, StatusBadge, type Column } from '@simplexd/ui';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { attempt } from '@/lib/admin/server/context';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listTemplateCatalog } from '@/server/admin/communications/service';
import { fmtDate } from '../../_components/bits';
import { CHANNEL_LABELS } from '../_lib/labels';

export const metadata: Metadata = { title: 'Notification templates' };
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

const CHANNELS = ['email', 'sms', 'in_app'] as const;

/**
 * One row per template family (key × channel × locale). Every version is
 * kept; the row shows which version sends today and whether a draft is
 * waiting. Editing always creates a new version.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/communications/templates');
  const ctx = adminContext(identity);
  const sp = await searchParams;
  const channelRaw = first(sp['channel']);
  const channel = (CHANNELS as readonly string[]).includes(channelRaw ?? '')
    ? (channelRaw as (typeof CHANNELS)[number])
    : undefined;
  const search = first(sp['search'])?.slice(0, 64);
  const loaded = await attempt(() => listTemplateCatalog(ctx, { channel, search }));

  const header = (
    <PageHeader
      title="Templates"
      description="Notification templates by event key and channel. Approving a version activates it and retires the previous one; earlier versions stay in the history and can be rolled back to."
    />
  );
  if (!loaded.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError code={loaded.code} message={loaded.message} what="Templates" />
      </div>
    );
  }

  const columns: Column<TemplateFamilySummaryDto>[] = [
    {
      key: 'key',
      header: 'Event key',
      cell: (f) => (
        <Link
          href={`/admin/communications/templates/${f.key}/${f.channel}?locale=${encodeURIComponent(f.locale)}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {f.key}
        </Link>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      cell: (f) => <Badge tone="neutral">{CHANNEL_LABELS[f.channel] ?? f.channel}</Badge>,
    },
    { key: 'locale', header: 'Locale', cell: (f) => <span className="text-xs">{f.locale}</span> },
    {
      key: 'active',
      header: 'Sends today',
      cell: (f) =>
        f.activeVersion !== null ? (
          <span>
            v{f.activeVersion}{' '}
            <span className="text-xs text-fg-muted">approved {fmtDate(f.activeApprovedAt)}</span>
          </span>
        ) : (
          <Badge tone="warning">No active version</Badge>
        ),
    },
    {
      key: 'latest',
      header: 'Latest',
      cell: (f) => (
        <span className="inline-flex items-center gap-2">
          v{f.latestVersion} <StatusBadge status={f.latestStatus} />
        </span>
      ),
    },
    {
      key: 'versions',
      header: 'Versions',
      cell: (f) => (
        <span className="text-xs">
          {f.versionCount}
          {f.draftCount > 0 ? ` (${f.draftCount} draft${f.draftCount === 1 ? '' : 's'})` : ''}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (f) => <span className="text-xs">{fmtDate(f.updatedAt)}</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-6">
      {header}
      <FilterBar>
        <FilterSelect
          name="channel"
          label="Channel"
          value={channel}
          options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c]! }))}
        />
        <FilterInput
          name="search"
          label="Event key contains"
          value={search}
          placeholder="invoice"
        />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={loaded.value}
        rowKey={(f) => `${f.key}|${f.channel}|${f.locale}`}
        rowLabel={(f) => `${f.key} ${f.channel}`}
        caption="Notification template families"
        emptyMessage="No templates match. Reference templates are loaded by the seed (ensureNotificationTemplates)."
      />
      <p className="text-sm text-fg-muted">
        Outside production a draft is used when no approved version exists and its output is
        labelled “[DRAFT TEMPLATE]”. In production only approved versions send; a family without one
        records a failed attempt (template_not_approved).
      </p>
    </div>
  );
}

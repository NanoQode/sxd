'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AdminObservationDto } from '@/server/admin/market-data/observations';
import { Badge, DataTable, StatusBadge, type Column } from '@simplexd/ui';
import { fmtDay } from '../../_components/bits';
import { humanize } from '../_lib/params';
import { ReviewActions } from './review-actions';

function valueLabel(o: AdminObservationDto): string {
  if (o.value !== null) return `${o.value.toLocaleString('en-NG')} ${o.unit}`;
  if (o.valueLow !== null || o.valueHigh !== null) return `${o.valueLow ?? '?'}–${o.valueHigh ?? '?'} ${o.unit}`;
  if (o.valueText) return o.valueText;
  return '—';
}

export function reviewStatusTone(status: string) {
  return status === 'verified' ? 'success' : status === 'rejected' ? 'danger' : status === 'disputed' || status === 'stale' ? 'warning' : 'info';
}

export function ObservationTable({
  items,
  actorId,
  canPublish,
  canEdit,
  caption,
  showMarket = true,
  emptyMessage = 'No observations.',
}: {
  items: AdminObservationDto[];
  actorId: string;
  canPublish: boolean;
  canEdit: boolean;
  caption: string;
  showMarket?: boolean;
  emptyMessage?: string;
}) {
  const router = useRouter();
  const columns: Column<AdminObservationDto>[] = [
    {
      key: 'metric',
      header: 'Metric',
      cell: (o) => (
        <div className="min-w-0">
          <Link href={`/admin/market-data/observations/${o.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
            {o.metric}
          </Link>
          <p className="text-xs text-fg-muted">
            {o.statistic} · {o.propertyCohort}
          </p>
        </div>
      ),
    },
    { key: 'value', header: 'Value', cell: (o) => <span className="whitespace-nowrap text-sm">{valueLabel(o)}</span> },
    {
      key: 'geo',
      header: 'Geography',
      cell: (o) => (
        <span className="text-xs">
          {humanize(o.geographyLevel)}
          <span className="block text-fg-muted">{showMarket ? (o.marketName ?? o.stateName ?? o.geographyLabel) : o.geographyLabel}</span>
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      hideOnMobile: true,
      cell: (o) => (
        <span className="text-xs">
          {o.source.title}
          <span className="block text-fg-muted">retrieved {fmtDay(o.retrievedAt)}{o.sampleSize !== null ? ` · n=${o.sampleSize}` : ''}</span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'Interpretation',
      cell: (o) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={reviewStatusTone(o.interpretation.reviewStatus)}>{humanize(o.interpretation.reviewStatus === 'source_read_pending_business_review' ? 'pending review' : o.interpretation.reviewStatus)}</Badge>
          <StatusBadge status={o.interpretation.publicationState} />
          {o.interpretation.rankEligible ? <Badge tone="gold">Rank-eligible</Badge> : null}
          <span className="text-xs text-fg-muted">v{o.interpretation.version}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Review',
      cell: (o) => (
        <div onClick={(e) => e.stopPropagation()}>
          <ReviewActions
            target={{
              id: o.id,
              metric: o.metric,
              statistic: o.statistic,
              geographyLevel: o.geographyLevel,
              interpretation: o.interpretation,
              createdBy: o.createdBy,
            }}
            actorId={actorId}
            canPublish={canPublish}
            canEdit={canEdit}
            compact
          />
        </div>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={items}
      rowKey={(o) => o.id}
      rowLabel={(o) => `${o.metric} ${o.geographyLabel}`}
      caption={caption}
      emptyMessage={emptyMessage}
      onRowClick={(o) => router.push(`/admin/market-data/observations/${o.id}`)}
    />
  );
}

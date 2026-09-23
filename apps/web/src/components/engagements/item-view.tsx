import type { ReactNode } from 'react';
import type { EngagementItemDto, EngagementItemKindDto } from '@simplexd/contracts';
import { Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { formatBytes } from '@/lib/portal/format';
import { SignedDownloadButton } from '@/components/portal/signed-download';

/**
 * Presentation of one engagement item shared by the customer portal, the
 * admin console and the partner workspace. No hooks: usable from server
 * components; the signed download button is the only client island.
 */

export const KIND_ORDER: EngagementItemKindDto[] = [
  'red_flag',
  'query',
  'document_check',
  'survey_reference',
  'site_finding',
  'condition',
  'closing_task',
  'handover_document',
  'lease_milestone',
];

export const KIND_GROUP_LABELS: Record<EngagementItemKindDto, string> = {
  red_flag: 'Red flags',
  query: 'Queries',
  document_check: 'Title and document checklist',
  survey_reference: 'Survey references',
  site_finding: 'Site findings',
  condition: 'Conditions',
  closing_task: 'Closing checklist',
  handover_document: 'Document handover',
  lease_milestone: 'Lease milestones',
};

export const SEVERITY_LABELS: Record<string, string> = {
  info: 'Info',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const STATUS_PRESENTATION: Record<string, { status: string; label: string }> = {
  open: { status: 'open', label: 'Open' },
  in_progress: { status: 'in_progress', label: 'In progress' },
  satisfied: { status: 'resolved', label: 'Satisfied' },
  waived: { status: 'closed', label: 'Waived' },
  failed: { status: 'failed', label: 'Failed' },
  cancelled: { status: 'cancelled', label: 'Cancelled' },
};

export function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return null;
  const tone =
    severity === 'critical' || severity === 'high'
      ? 'danger'
      : severity === 'medium'
        ? 'warning'
        : severity === 'low'
          ? 'info'
          : 'neutral';
  return (
    <Badge tone={tone} aria-label={`Severity ${SEVERITY_LABELS[severity] ?? severity}`}>
      {SEVERITY_LABELS[severity] ?? humanize(severity)}
    </Badge>
  );
}

export function ItemStatusBadge({ status }: { status: string }) {
  const p = STATUS_PRESENTATION[status] ?? { status, label: humanize(status) };
  return <StatusBadge status={p.status} label={p.label} />;
}

export function VisibilityBadge({ visibility }: { visibility: string }) {
  const labels: Record<string, string> = {
    internal: 'Staff only',
    customer: 'Customer',
    partner: 'Partners',
    all: 'Customer and partners',
  };
  return (
    <Badge tone={visibility === 'internal' ? 'neutral' : 'primary'}>
      {labels[visibility] ?? humanize(visibility)}
    </Badge>
  );
}

/** Groups items by kind in the display order; empty kinds are omitted. */
export function groupItems(
  items: EngagementItemDto[],
): Array<{ kind: EngagementItemKindDto; label: string; items: EngagementItemDto[] }> {
  return KIND_ORDER.flatMap((kind) => {
    const list = items.filter((i) => i.kind === kind);
    return list.length === 0 ? [] : [{ kind, label: KIND_GROUP_LABELS[kind], items: list }];
  });
}

export function ItemHeading({ item, extra }: { item: EngagementItemDto; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium break-words">{item.title}</p>
        <p className="text-xs text-fg-muted">{item.kindLabel}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={item.severity} />
        <ItemStatusBadge status={item.status} />
        {extra}
      </div>
    </div>
  );
}

export function ItemMeta({ item, zone }: { item: EngagementItemDto; zone: string }) {
  const rows: Array<[string, ReactNode]> = [];
  if (item.reference) rows.push(['Reference', item.reference]);
  if (item.assigneeName) rows.push(['Assigned to', item.assigneeName]);
  if (item.dueAt) rows.push(['Due', formatDateTimeLabel(item.dueAt, zone)]);
  if (item.resolvedAt)
    rows.push([
      'Closed',
      `${formatDateTimeLabel(item.resolvedAt, zone)}${item.resolvedByName ? ` by ${item.resolvedByName}` : ''}`,
    ]);
  return (
    <div className="space-y-2 text-sm">
      {item.detail ? <p className="whitespace-pre-wrap">{item.detail}</p> : null}
      {rows.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          {rows.map(([term, value]) => (
            <div key={term} className="flex flex-wrap gap-1">
              <dt className="text-fg-muted">{term}:</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.resolutionNote ? (
        <p className="rounded-md bg-bg-sunken p-2 text-xs">
          <span className="font-medium">Resolution:</span> {item.resolutionNote}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Evidence the caller may open. `mode` picks how a file opens: the signed
 * download button (portal, partner) or the admin download link.
 */
export function ItemEvidenceList({
  item,
  mode,
  zone,
}: {
  item: EngagementItemDto;
  mode: 'signed' | 'admin';
  zone: string;
}) {
  if (item.evidence.length === 0) {
    return <p className="text-xs text-fg-muted">No evidence attached yet.</p>;
  }
  return (
    <ul className="space-y-1 text-sm" aria-label={`Evidence for ${item.title}`}>
      {item.evidence.map((e) => (
        <li
          key={e.fileId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
        >
          <span className="min-w-0">
            <span className="font-medium break-all">{e.originalName}</span>
            <span className="block text-xs text-fg-muted">
              {formatBytes(e.sizeBytes)}
              {e.uploadedByName ? ` · ${e.uploadedByName}` : ''} ·{' '}
              {formatDateTimeLabel(e.receivedAt, zone)}
              {e.status !== 'clean' ? ` · ${humanize(e.status)}` : ''}
            </span>
          </span>
          {mode === 'signed' ? (
            <SignedDownloadButton fileId={e.fileId} fileName={e.originalName} status={e.status} />
          ) : e.status === 'clean' ? (
            <a href={`/api/v1/files/${e.fileId}/download`} className="text-sm underline">
              Download
            </a>
          ) : (
            <span className="text-xs text-fg-muted">{humanize(e.status)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ItemResponses({ item, zone }: { item: EngagementItemDto; zone: string }) {
  if (item.responses.length === 0) return null;
  return (
    <ol className="space-y-2" aria-label={`Replies on ${item.title}`}>
      {item.responses.map((r) => (
        <li key={r.id} className="rounded-md bg-bg-sunken p-2 text-sm">
          <p className="text-xs text-fg-muted">
            {r.authorName ?? 'Someone'} · {humanize(r.authorRole)} ·{' '}
            {formatDateTimeLabel(r.createdAt, zone)}
          </p>
          <p className="whitespace-pre-wrap">{r.body}</p>
        </li>
      ))}
    </ol>
  );
}

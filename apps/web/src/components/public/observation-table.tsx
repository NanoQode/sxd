import type { ObservationDto } from '@simplexd/contracts';
import { Badge, DataTable, EvidenceBadge, formatNumber, formatWholeNaira, type Column } from '@simplexd/ui';

/** Formats an observation value with its declared representation and unit. */
export function observationValue(o: ObservationDto): string {
  const money = o.numericRepresentation === 'whole_naira_not_kobo';
  const fmt = (n: number) => (money ? formatWholeNaira(n) : formatNumber(n, Number.isInteger(n) ? 0 : 2));
  if (o.value !== null) return `${fmt(o.value)}${money ? '' : ` ${o.unit}`}${money ? ` (${o.unit})` : ''}`;
  if (o.valueLow !== null || o.valueHigh !== null) {
    const low = o.valueLow !== null ? fmt(o.valueLow) : '?';
    const high = o.valueHigh !== null ? fmt(o.valueHigh) : '?';
    return `${low} – ${high}${money ? ` (${o.unit})` : ` ${o.unit}`}`;
  }
  if (o.valueText) return o.valueText;
  return 'Unknown';
}

function period(o: ObservationDto): string {
  if (o.observationPeriodStart || o.observationPeriodEnd) {
    const range = `${o.observationPeriodStart ?? '?'} to ${o.observationPeriodEnd ?? '?'}`;
    return o.periodCompleteAtRetrieval === false ? `${range} (period incomplete at retrieval)` : range;
  }
  return 'Not stated';
}

export function ObservationTable({
  observations,
  caption,
  statewide = false,
}: {
  observations: ObservationDto[];
  caption: string;
  statewide?: boolean;
}) {
  const columns: Column<ObservationDto>[] = [
    {
      key: 'metric',
      header: 'Metric',
      cell: (o) => (
        <div>
          <p className="font-medium">{o.metric.replace(/_/g, ' ')}</p>
          <p className="text-xs text-fg-muted">
            {o.statistic} · {o.propertyCohort}
          </p>
          {statewide ? (
            <Badge tone="warning" className="mt-1">
              Statewide context, not a city value
            </Badge>
          ) : null}
        </div>
      ),
    },
    { key: 'value', header: 'Value', cell: (o) => <span className="font-mono text-sm">{observationValue(o)}</span> },
    { key: 'scope', header: 'Geography', cell: (o) => `${o.geographyLabel} (${o.geographyLevel.replace(/_/g, ' ')})` },
    { key: 'period', header: 'Observation period', cell: (o) => period(o) },
    { key: 'retrieved', header: 'Retrieved', cell: (o) => o.retrievedAt },
    {
      key: 'sample',
      header: 'Sample size',
      cell: (o) => (o.sampleSize === null ? 'Not captured' : formatNumber(o.sampleSize)),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (o) =>
        o.source.url ? (
          <a href={o.source.url} rel="noopener noreferrer" target="_blank" className="text-primary underline">
            {o.source.title}
          </a>
        ) : (
          o.source.title
        ),
    },
    {
      key: 'badge',
      header: 'Evidence',
      cell: (o) => (
        <div className="flex flex-wrap gap-1">
          <EvidenceBadge kind={o.badge} />
          {o.freshness === 'stale' ? <Badge tone="warning">Stale</Badge> : null}
          {!o.rankEligible ? <Badge tone="neutral">Not rank-eligible</Badge> : null}
        </div>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={observations}
      rowKey={(o) => o.id}
      rowLabel={(o) => `${o.metric.replace(/_/g, ' ')} (${o.geographyLabel})`}
      caption={caption}
      emptyMessage="No observations published for this scope."
    />
  );
}

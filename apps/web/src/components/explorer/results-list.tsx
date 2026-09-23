import { ArrowRight, Scale, SearchX } from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, EmptyState, Skeleton, cn } from '@simplexd/ui';
import type { RecommendationResponse } from '@simplexd/contracts';
import {
  COPY,
  ZONE_LABELS,
  metricLabel,
  statusSummary,
  type MarketRow,
  type MarketRows,
} from '@/lib/explorer';
import { ErrorState } from './error-state';
import { AvailabilityBadge, EvidenceBadgeRow, MarketStatusPill } from './market-status';

/**
 * Accessible results list: the keyboard and screen-reader equivalent of the
 * map with the map's complete functionality (select, compare, status,
 * evidence). Sorted by rank when a ranking exists, otherwise by name.
 */

export interface ResultsListProps {
  rows: MarketRows;
  recommendation: RecommendationResponse | null;
  selectedSlug: string | null;
  compareSlugs: readonly string[];
  compareFull: boolean;
  totalCount: number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onSelect: (slug: string) => void;
  onToggleCompare: (slug: string) => void;
  onCompareWithAssumptions?: () => void;
  onResetFilters?: () => void;
  /** Homepage variant: show only the first n rows and a link to the rest. */
  limit?: number;
  moreHref?: string;
  headingId?: string;
}

function ResultRow({
  row,
  recommendation,
  selected,
  compared,
  compareFull,
  onSelect,
  onToggleCompare,
  onCompareWithAssumptions,
}: {
  row: MarketRow;
  recommendation: RecommendationResponse | null;
  selected: boolean;
  compared: boolean;
  compareFull: boolean;
  onSelect: (slug: string) => void;
  onToggleCompare: (slug: string) => void;
  onCompareWithAssumptions?: () => void;
}) {
  const { market, ranked } = row;
  const summary = statusSummary(ranked, recommendation);
  const nameId = `market-${market.slug}-name`;
  const rank = ranked?.status === 'ranked' && ranked.rank !== null ? ranked.rank : null;
  return (
    <li>
      <article
        aria-labelledby={nameId}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'sx-transition rounded-lg border bg-bg-elevated p-3',
          selected ? 'border-primary shadow-sm' : 'border-border',
        )}
        data-testid="result-row"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 id={nameId} className="font-semibold leading-tight">
              {rank !== null ? <span className="text-fg-muted">{rank}. </span> : null}
              {market.name}
            </h3>
            <p className="text-sm text-fg-muted">
              {market.stateName} · {ZONE_LABELS[market.geopoliticalZone]}
              {market.isFederalCapital ? ' · Federal capital' : ''}
            </p>
          </div>
          <MarketStatusPill ranked={ranked} recommendation={recommendation} />
        </div>
        {summary.detail ? <p className="mt-1 text-sm text-fg-muted">{summary.detail}</p> : null}
        {ranked?.status === 'more_local_data_needed' && onCompareWithAssumptions ? (
          <div className="mt-1 text-sm">
            <button
              type="button"
              className="sx-touch inline-flex items-center gap-1 text-primary underline underline-offset-4"
              onClick={onCompareWithAssumptions}
            >
              {COPY.compareWithAssumptions}
            </button>
          </div>
        ) : null}
        {market.overlapNote ? (
          <p className="mt-1 text-xs text-warning">
            Overlapping metropolitan market: {market.overlapNote}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-fg-muted">
          {market.evidence.localObservations} local observation
          {market.evidence.localObservations === 1 ? '' : 's'} ·{' '}
          {market.evidence.regionalContextObservations} statewide context ·{' '}
          {market.evidence.supplierLeads} supplier lead
          {market.evidence.supplierLeads === 1 ? '' : 's'}
          {market.evidence.supplierQuotes > 0
            ? ` · ${market.evidence.supplierQuotes} verified quotes`
            : ''}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <AvailabilityBadge availability={market.serviceAvailability} />
          <EvidenceBadgeRow badges={market.evidence.badges} />
          {market.evidence.badges.length === 0 ? (
            <Badge tone="neutral">No evidence badges yet</Badge>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => onSelect(market.slug)} aria-pressed={selected}>
            View details
          </Button>
          <Button
            variant={compared ? 'primary' : 'ghost'}
            onClick={() => onToggleCompare(market.slug)}
            aria-pressed={compared}
            disabled={!compared && compareFull}
            title={!compared && compareFull ? 'Comparison tray is full (four markets)' : undefined}
          >
            <Scale aria-hidden="true" className="h-4 w-4" />
            {compared ? 'Remove from comparison' : 'Compare'}
          </Button>
        </div>
      </article>
    </li>
  );
}

export function ResultsList({
  rows,
  recommendation,
  selectedSlug,
  compareSlugs,
  compareFull,
  totalCount,
  loading,
  error,
  onRetry,
  onSelect,
  onToggleCompare,
  onCompareWithAssumptions,
  onResetFilters,
  limit,
  moreHref,
  headingId = 'explorer-results-heading',
}: ResultsListProps) {
  const organic = limit ? rows.organic.slice(0, limit) : rows.organic;
  const hidden = rows.organic.length - organic.length;
  const matching = rows.organic.length + rows.sponsored.length;

  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="results-list">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Results
        </h2>
        <p aria-live="polite" aria-atomic="true" className="text-sm text-fg-muted">
          {loading
            ? 'Loading markets…'
            : `${matching} of ${totalCount} market${totalCount === 1 ? '' : 's'} match`}
          {recommendation && !recommendation.rankingEnabled ? ' · listed by name' : ''}
        </p>
      </div>

      {recommendation && !recommendation.rankingEnabled && recommendation.rankingDisabledReason ? (
        <p className="rounded-md border border-border bg-bg-sunken p-2 text-xs text-fg-muted">
          Financial ranking is not active: {recommendation.rankingDisabledReason}
        </p>
      ) : null}

      {error ? (
        <ErrorState title="Markets could not be loaded" error={error} onRetry={onRetry} />
      ) : null}

      {loading && !error ? (
        <ul className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-28 w-full rounded-lg" />
            </li>
          ))}
        </ul>
      ) : null}

      {!loading && !error && matching === 0 ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="h-6 w-6" />}
          title="No markets match these filters"
          description="Unknown data is never treated as a match or a miss: widen the filters or allow unknown values to see more markets."
          action={
            onResetFilters ? (
              <Button variant="secondary" onClick={onResetFilters}>
                Reset filters
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {organic.length > 0 ? (
        <ul className="space-y-2" aria-label="Markets">
          {organic.map((row) => (
            <ResultRow
              key={row.market.slug}
              row={row}
              recommendation={recommendation}
              selected={row.market.slug === selectedSlug}
              compared={compareSlugs.includes(row.market.slug)}
              compareFull={compareFull}
              onSelect={onSelect}
              onToggleCompare={onToggleCompare}
              onCompareWithAssumptions={onCompareWithAssumptions}
            />
          ))}
        </ul>
      ) : null}

      {hidden > 0 && moreHref ? (
        <p>
          <Link
            href={moreHref}
            className="sx-touch inline-flex items-center gap-1 text-primary underline underline-offset-4"
          >
            See all {rows.organic.length} matching markets in the full explorer
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </p>
      ) : null}

      {rows.sponsored.length > 0 ? (
        <section
          aria-labelledby={`${headingId}-sponsored`}
          className="rounded-lg border border-gold/60 bg-gold-soft/40 p-3"
        >
          <h3 id={`${headingId}-sponsored`} className="text-sm font-semibold">
            Sponsored placements
          </h3>
          <p className="mb-2 text-xs text-fg-muted">
            Labelled and kept apart from the organic list; sponsorship never changes a fit score.
          </p>
          <ul className="space-y-2">
            {rows.sponsored.map((row) => (
              <ResultRow
                key={row.market.slug}
                row={row}
                recommendation={recommendation}
                selected={row.market.slug === selectedSlug}
                compared={compareSlugs.includes(row.market.slug)}
                compareFull={compareFull}
                onSelect={onSelect}
                onToggleCompare={onToggleCompare}
                onCompareWithAssumptions={onCompareWithAssumptions}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {rows.excluded.length > 0 ? (
        <details className="rounded-lg border border-border p-3">
          <summary className="sx-touch flex cursor-pointer items-center text-sm font-medium">
            Excluded by your constraints ({rows.excluded.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {rows.excluded.map((row) => (
              <li key={row.market.slug} className="flex flex-wrap justify-between gap-2">
                <span>
                  {row.market.name}, {row.market.stateName}
                </span>
                <span className="text-fg-muted">
                  {row.ranked?.exclusionReason
                    ? metricLabel(row.ranked.exclusionReason)
                    : 'Excluded by policy'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

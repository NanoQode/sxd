import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { MarketSummaryDto } from '@simplexd/contracts';
import { Badge, formatDateLabel } from '@simplexd/ui';
import { AvailabilityBadge, recommendationLabel } from './availability-badge';

export const ZONE_NAMES: Record<MarketSummaryDto['geopoliticalZone'], string> = {
  NC: 'North Central',
  NE: 'North East',
  NW: 'North West',
  SE: 'South East',
  SS: 'South South',
  SW: 'South West',
};

export function MarketCard({ market }: { market: MarketSummaryDto }) {
  const e = market.evidence;
  return (
    <article className="relative flex h-full flex-col rounded-lg border border-border bg-bg-elevated p-4 shadow-sm">
      <h3 className="text-base font-semibold leading-tight">
        <Link
          href={`/locations/${market.slug}`}
          className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {market.name}
        </Link>
      </h3>
      <p className="text-sm text-fg-muted">
        {market.stateName}
        {market.isFederalCapital ? ' (FCT)' : ' State'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <AvailabilityBadge value={market.serviceAvailability} />
        {e.freshness === 'stale' ? <Badge tone="warning">Evidence stale</Badge> : null}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-fg-muted">
        <dt>Local observations</dt>
        <dd className="text-fg">{e.localObservations}</dd>
        <dt>Statewide context</dt>
        <dd className="text-fg">{e.regionalContextObservations}</dd>
        <dt>Supplier leads</dt>
        <dd className="text-fg">{e.supplierLeads}</dd>
        <dt>Open research tasks</dt>
        <dd className="text-fg">{e.openResearchTasks}</dd>
      </dl>
      <p className="mt-3 text-xs text-fg-subtle">
        {recommendationLabel(market.recommendationStatus)}
        {e.lastReviewedAt
          ? ` · Reviewed ${formatDateLabel(e.lastReviewedAt)}`
          : ' · Not yet reviewed'}
      </p>
      <span className="mt-auto inline-flex items-center gap-1 pt-3 text-sm font-medium text-primary">
        View evidence
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </span>
    </article>
  );
}

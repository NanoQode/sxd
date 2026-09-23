import { ExternalLink } from 'lucide-react';
import { EvidenceBadge } from '@simplexd/ui';
import { formatDateLabel, formatNairaString, formatNumber } from '@simplexd/ui/format';
import type { ObservationDto, SupplierLeadDto, SupplierQuoteDto } from '@simplexd/contracts';
import { COPY, formatObservationValue, humanizeKey } from '@/lib/explorer';

/** Observations with badge, unit, dates, sample size and source link. */
export function ObservationList({
  observations,
  statewide = false,
  emptyMessage,
}: {
  observations: readonly ObservationDto[];
  /** Statewide context: every item is labelled as such and never presented as a city value. */
  statewide?: boolean;
  emptyMessage: string;
}) {
  if (observations.length === 0) {
    return <p className="text-sm text-fg-muted">{emptyMessage}</p>;
  }
  return (
    <ul className="space-y-2">
      {observations.map((o) => {
        const period =
          o.observationPeriodStart || o.observationPeriodEnd
            ? `${o.observationPeriodStart ? formatDateLabel(o.observationPeriodStart) : '?'} – ${
                o.observationPeriodEnd ? formatDateLabel(o.observationPeriodEnd) : '?'
              }`
            : o.sourceUpdatedAt
              ? `Source updated ${formatDateLabel(o.sourceUpdatedAt)}`
              : 'Observation period not stated';
        return (
          <li
            key={o.id}
            className="rounded-md border border-border p-2 text-sm"
            data-testid="observation"
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="font-medium">{humanizeKey(o.metric)}</span>
              <EvidenceBadge kind={statewide ? 'regional_context' : o.badge} showDescription />
            </div>
            <p className="mt-0.5 text-base font-semibold tabular-nums">
              {formatObservationValue(o)}{' '}
              <span className="text-xs font-normal text-fg-muted">
                {o.unit} · {humanizeKey(o.statistic)}
              </span>
            </p>
            {statewide || o.geographyLevel === 'state_or_fct' || o.geographyLevel === 'country' ? (
              <p className="text-xs font-medium text-warning">
                {COPY.statewideContext} ({o.geographyLabel})
              </p>
            ) : null}
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-fg-muted">
              <dt>Cohort</dt>
              <dd>{humanizeKey(o.propertyCohort)}</dd>
              <dt>Observed</dt>
              <dd>
                {period}
                {o.periodCompleteAtRetrieval === false ? ' (period incomplete at retrieval)' : ''}
              </dd>
              <dt>Retrieved</dt>
              <dd>{formatDateLabel(o.retrievedAt)}</dd>
              <dt>Sample size</dt>
              <dd>{o.sampleSize !== null ? formatNumber(o.sampleSize) : 'Not stated'}</dd>
              <dt>Freshness</dt>
              <dd>{humanizeKey(o.freshness)}</dd>
              <dt>Source</dt>
              <dd>
                {o.source.url ? (
                  <a
                    href={o.source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                  >
                    {o.source.title}
                    <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : (
                  o.source.title
                )}
              </dd>
            </dl>
            {!o.rankEligible && o.reasonNotRankEligible ? (
              <p className="mt-1 text-xs text-fg-muted">
                Not used for ranking: {o.reasonNotRankEligible}
              </p>
            ) : null}
            {o.editorialNote ? (
              <p className="mt-1 text-xs text-fg-muted">{o.editorialNote}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function SupplierLeadList({ leads }: { leads: readonly SupplierLeadDto[] }) {
  if (leads.length === 0)
    return <p className="text-sm text-fg-muted">No supplier research leads recorded yet.</p>;
  return (
    <ul className="space-y-2">
      {leads.map((lead) => (
        <li
          key={`${lead.facilityId}-${lead.relation}`}
          className="rounded-md border border-border p-2 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-medium">
              {lead.name}
              {lead.operator ? <span className="text-fg-muted"> · {lead.operator}</span> : null}
            </span>
            <EvidenceBadge kind={lead.badge} showDescription />
          </div>
          <p className="text-xs text-fg-muted">
            {humanizeKey(lead.material)}
            {lead.stateName ? ` · ${lead.stateName}` : ''} · {humanizeKey(lead.relation)} ·{' '}
            {humanizeKey(lead.evidenceStatus)} · stock {humanizeKey(lead.stockStatus)} ·{' '}
            {lead.deliveryCoverageVerified
              ? 'delivery coverage verified'
              : 'delivery coverage not verified'}
          </p>
          {lead.note ? <p className="mt-1 text-xs text-fg-muted">{lead.note}</p> : null}
          {lead.source?.url ? (
            <a
              href={lead.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
            >
              {lead.source.title}
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function SupplierQuoteList({ quotes }: { quotes: readonly SupplierQuoteDto[] }) {
  if (quotes.length === 0) return <p className="text-sm text-fg-muted">{COPY.noSupplierQuotes}</p>;
  return (
    <ul className="space-y-2">
      {quotes.map((quote) => (
        <li key={quote.id} className="rounded-md border border-border p-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-medium">
              {humanizeKey(quote.material)} · {quote.specification}
            </span>
            <EvidenceBadge kind={quote.badge} showDescription />
          </div>
          <p className="tabular-nums">
            {quote.unitPrice ? formatNairaString(quote.unitPrice.amountKobo) : 'Price not stated'}{' '}
            per {quote.unit}
            {quote.deliveryCost
              ? ` · delivery ${formatNairaString(quote.deliveryCost.amountKobo)}`
              : ' · delivery not quoted'}
            {quote.leadTimeDays !== null ? ` · lead time ${quote.leadTimeDays} days` : ''}
          </p>
          <p className="text-xs text-fg-muted">
            Quoted {formatDateLabel(quote.quotedAt)}
            {quote.validUntil ? ` · valid until ${formatDateLabel(quote.validUntil)}` : ''} ·{' '}
            {humanizeKey(quote.freshness)}
            {quote.rankEligible ? '' : ' · not used for ranking'}
          </p>
        </li>
      ))}
    </ul>
  );
}

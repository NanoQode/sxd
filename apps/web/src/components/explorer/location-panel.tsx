'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Scale, Save, ShieldQuestion, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  EvidenceBadge,
  Skeleton,
  StatusBadge,
} from '@simplexd/ui';
import { formatDateLabel, formatDateTimeLabel, formatPercent } from '@simplexd/ui/format';
import type { MarketDetailDto, RankedMarketDto, RecommendationResponse } from '@simplexd/contracts';
import {
  AVAILABILITY_LABELS,
  COPY,
  FLOOD_LABELS,
  ZONE_LABELS,
  floodStatusOf,
  formatMonthIndex,
  formatScenarioNaira,
  getMarketDetail,
  humanizeKey,
  numberResult,
  plainParagraphs,
  type CalculatorRunResult,
  type ExplorerMode,
} from '@/lib/explorer';
import { ErrorState } from './error-state';
import { ObservationList, SupplierLeadList, SupplierQuoteList } from './evidence-list';
import { useExplorer } from './explorer-context';
import { EvidenceBadgeRow, MarketStatusPill } from './market-status';

/**
 * Selected location panel: profile, service coverage vs map coverage, local
 * and statewide observations (labelled), supplier leads, tenders, expected
 * schedule and forecast under the user's assumptions, environmental checks
 * and next actions, with "Why this matches", "Missing evidence" and
 * "Last reviewed". Desktop: right column; mobile: accessible bottom sheet.
 */

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface LocationPanelContentProps {
  detail: MarketDetailDto;
  ranked: RankedMarketDto | null;
  recommendation: RecommendationResponse | null;
  mode: ExplorerMode;
  calculators: CalculatorRunResult | null;
  compared: boolean;
  compareFull: boolean;
  scenarioId: string | null;
  onToggleCompare: () => void;
  onSaveScenario: () => void;
  onRequestVerification: () => void;
  onSwitchToAssumptions: () => void;
}

export function LocationPanelContent({
  detail,
  ranked,
  recommendation,
  mode,
  calculators,
  compared,
  compareFull,
  scenarioId,
  onToggleCompare,
  onSaveScenario,
  onRequestVerification,
  onSwitchToAssumptions,
}: LocationPanelContentProps) {
  const prefix = `loc-${detail.slug}`;
  const missingEvidence = [...new Set([...(ranked?.missingEvidence ?? []), ...detail.missingEvidence])];
  const lastReviewed = detail.lastReviewedAt ?? detail.evidence.lastReviewedAt;
  const activeFlags = detail.flags.filter((flag) => flag.active);
  const flood = floodStatusOf(detail, ranked);
  const title = ranked?.riskAssessment.title ?? 'unable_to_assess';
  const phasing = calculators?.phasing ?? null;
  const longLet = calculators?.longLet ?? null;
  const bookHref = `/book?market=${encodeURIComponent(detail.slug)}${
    scenarioId ? `&scenario=${encodeURIComponent(scenarioId)}` : ''
  }`;
  const paragraphs = plainParagraphs(detail.profileMarkdown);

  return (
    <div className="space-y-5" data-testid="location-panel">
      <header className="space-y-1">
        <p className="text-sm text-fg-muted">
          {detail.stateName} · {ZONE_LABELS[detail.geopoliticalZone]}
          {detail.isFederalCapital ? ' · Federal capital' : ''}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <MarketStatusPill ranked={ranked} recommendation={recommendation} />
          <StatusBadge
            status={detail.serviceAvailability}
            label={AVAILABILITY_LABELS[detail.serviceAvailability] ?? detail.serviceAvailability}
          />
          <EvidenceBadgeRow badges={detail.evidence.badges} max={8} />
        </div>
        <p className="text-xs text-fg-muted">
          Map position {detail.location.lat.toFixed(4)}°N, {detail.location.lon.toFixed(4)}°E ·{' '}
          {detail.coordinateAccuracy ? humanizeKey(detail.coordinateAccuracy) : 'reference point'}
          {detail.coordinateSource ? ` · ${detail.coordinateSource.title}` : ''}
        </p>
        {detail.overlapNote ? (
          <p className="text-xs font-medium text-warning">Overlapping metropolitan market: {detail.overlapNote}</p>
        ) : null}
      </header>

      {paragraphs.length > 0 ? (
        <Section id={`${prefix}-profile`} title="Profile">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-sm">
              {p}
            </p>
          ))}
          {detail.selectionBasis ? (
            <p className="text-xs text-fg-muted">Selection basis: {detail.selectionBasis}</p>
          ) : null}
        </Section>
      ) : (
        <Section id={`${prefix}-profile`} title="Profile">
          <p className="text-sm text-fg-muted">
            No editorial profile published yet.
            {detail.selectionBasis ? ` Selection basis: ${detail.selectionBasis}` : ''}
          </p>
        </Section>
      )}

      <Section id={`${prefix}-why`} title="Why this matches">
        {ranked && ranked.whyMatches.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {ranked.whyMatches.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            {ranked?.status === 'more_local_data_needed'
              ? `${COPY.moreLocalData}: this market is visible but not eligible for financial ranking yet.`
              : 'No ranking explanation yet: this market is not ranked under the current policy.'}
          </p>
        )}
        {ranked && (ranked.fit !== null || ranked.assumptionFit !== null) ? (
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-fg-muted">{ranked.fit !== null ? 'Fit' : 'Assumption fit'}</dt>
              <dd className="font-semibold tabular-nums">{Math.round(ranked.fit ?? ranked.assumptionFit ?? 0)}/100</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Coverage</dt>
              <dd className="font-semibold tabular-nums">{ranked.coverage !== null ? formatPercent(ranked.coverage * 100, 0) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Confidence</dt>
              <dd className="font-semibold tabular-nums">{ranked.confidence !== null ? formatPercent(ranked.confidence * 100, 0) : '—'}</dd>
            </div>
          </dl>
        ) : null}
        {ranked && ranked.topContributors.length > 0 ? (
          <p className="text-xs text-fg-muted">
            Top contributors:{' '}
            {ranked.topContributors
              .map((c) => `${humanizeKey(c.metric)}${c.contribution !== null ? ` (${c.contribution.toFixed(1)} pts)` : ''}`)
              .join(', ')}
          </p>
        ) : null}
        {ranked?.status === 'more_local_data_needed' ? (
          <Button variant="secondary" onClick={onSwitchToAssumptions}>
            {COPY.compareWithAssumptions}
          </Button>
        ) : null}
      </Section>

      <Section id={`${prefix}-missing`} title="Missing evidence">
        {missingEvidence.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {missingEvidence.map((item) => (
              <li key={item}>{humanizeKey(item)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No missing evidence listed for the current objective.</p>
        )}
        {detail.researchTasks.length > 0 ? (
          <p className="text-xs text-fg-muted">
            {detail.researchTasks.filter((t) => t.status !== 'done' && t.status !== 'completed').length} open research
            task(s): {detail.researchTasks.map((t) => t.title).slice(0, 4).join('; ')}
            {detail.researchTasks.length > 4 ? '…' : ''}
          </p>
        ) : null}
      </Section>

      <Section id={`${prefix}-reviewed`} title="Last reviewed">
        <p className="text-sm">
          {lastReviewed ? formatDateTimeLabel(lastReviewed) : 'Not yet reviewed by SimplexD staff'}
          {detail.evidence.lastResearchedAt ? (
            <span className="text-fg-muted"> · last researched {formatDateLabel(detail.evidence.lastResearchedAt)}</span>
          ) : null}
        </p>
      </Section>

      <Section id={`${prefix}-coverage`} title="Service coverage">
        <p className="text-xs text-fg-muted">{COPY.coverageVsAvailability}</p>
        {detail.serviceCoverage.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {detail.serviceCoverage.map((service) => (
              <li key={service.serviceSlug} className="flex flex-wrap items-center justify-between gap-1">
                <span>{service.serviceName}</span>
                <StatusBadge status={service.availability} label={AVAILABILITY_LABELS[service.availability] ?? service.availability} />
                {service.note ? <span className="w-full text-xs text-fg-muted">{service.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            Per-service availability has not been confirmed by operations for this market.
          </p>
        )}
      </Section>

      <Section id={`${prefix}-local`} title={`Local observations (${detail.localObservations.length})`}>
        <ObservationList
          observations={detail.localObservations}
          emptyMessage={`${COPY.moreLocalData}: no city-level observations have been published for ${detail.name} yet.`}
        />
      </Section>

      <Section id={`${prefix}-statewide`} title={`Statewide context (${detail.regionalContextObservations.length})`}>
        <p className="text-xs text-fg-muted">{COPY.statewideContext}; shown for context only and never used as a city figure.</p>
        <ObservationList observations={detail.regionalContextObservations} statewide emptyMessage="No statewide context observations linked." />
      </Section>

      <Section id={`${prefix}-neighbourhoods`} title="Neighbourhoods">
        {detail.neighborhoods.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {detail.neighborhoods.map((n) => (
              <li key={n.id}>
                <Badge tone="neutral">
                  {n.name}
                  {n.hasBoundary ? '' : ' (point only)'}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No neighbourhood drill-down published yet.</p>
        )}
      </Section>

      <Section id={`${prefix}-suppliers`} title="Material suppliers">
        <SupplierQuoteList quotes={detail.supplierQuotes} />
        {detail.supplierLeads.length > 0 ? (
          <>
            <p className="text-xs text-fg-muted">
              Research leads ({detail.supplierLeads.length}) — editorial pointers, not verified distribution routes.
              {detail.supplyMappingMethod ? ` ${detail.supplyMappingMethod}` : ''}
            </p>
            <SupplierLeadList leads={detail.supplierLeads} />
          </>
        ) : null}
      </Section>

      <Section id={`${prefix}-tenders`} title="Tender opportunities">
        <p className="text-sm text-fg-muted">{COPY.noTenders}</p>
        {ranked?.biddingWindowDays !== null && ranked?.biddingWindowDays !== undefined ? (
          <p className="text-sm">
            Bidding window: {ranked.biddingWindowDays} days (a schedule constraint, never a score).
          </p>
        ) : null}
      </Section>

      <Section id={`${prefix}-schedule`} title="Expected project schedule (your assumptions)">
        {mode === 'assumption' && phasing ? (
          phasing.ok ? (
            <p className="text-sm">
              Construction {phasing.value.schedule.constructionDurationMonths} months plus a completion delay of{' '}
              {phasing.value.schedule.completionDelayMonths} months: rental income is assumed from{' '}
              {formatMonthIndex(phasing.value.schedule.rentalStartIndex)} after start.{' '}
              <span className="text-fg-muted">{COPY.notPromisedDate}</span>
            </p>
          ) : (
            <p className="text-sm text-fg-muted">Schedule not computed: {phasing.reason}</p>
          )
        ) : (
          <p className="text-sm text-fg-muted">
            Switch to assumption mode and enter construction months and a completion delay to model a schedule.{' '}
            {COPY.notPromisedDate}
          </p>
        )}
        {detail.timelineTemplate ? (
          <p className="text-xs text-fg-muted">
            Template “{detail.timelineTemplate.name}” ({humanizeKey(detail.timelineTemplate.status)}):{' '}
            {detail.timelineTemplate.canComputeCompletionDate
              ? 'can compute a completion date from its inputs.'
              : `cannot compute a completion date yet${
                  detail.timelineTemplate.missingInputs.length > 0
                    ? ` — missing ${detail.timelineTemplate.missingInputs.join(', ')}`
                    : ''
                }.`}
            {detail.timelineTemplate.assumptionNotes ? ` ${detail.timelineTemplate.assumptionNotes}` : ''}
          </p>
        ) : null}
      </Section>

      <Section id={`${prefix}-forecast`} title="Forecast rent and cash flow (your assumptions)">
        {mode === 'assumption' && longLet ? (
          longLet.ok ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-fg-muted">Scheduled annual rent</dt>
              <dd className="tabular-nums">{formatScenarioNaira(longLet.value.scheduledAnnualRent)}</dd>
              <dt className="text-fg-muted">Effective income</dt>
              <dd className="tabular-nums">{formatScenarioNaira(longLet.value.effectiveIncome)}</dd>
              <dt className="text-fg-muted">Net operating income</dt>
              <dd className="tabular-nums">{formatScenarioNaira(longLet.value.noi)}</dd>
              <dt className="text-fg-muted">Cash flow after debt</dt>
              <dd className="tabular-nums">{formatScenarioNaira(longLet.value.cashFlowAfterDebt)}</dd>
              <dt className="text-fg-muted">Net yield (denominator: development cost)</dt>
              <dd className="tabular-nums">
                {(() => {
                  const y = numberResult(longLet.value.netYieldPercent);
                  return y.ok ? formatPercent(y.value) : y.reason;
                })()}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-fg-muted">Not computed: {longLet.reason}</p>
          )
        ) : (
          <p className="text-sm text-fg-muted">
            Available in assumption mode from your own inputs. {COPY.scenarioDisclaimer}
          </p>
        )}
      </Section>

      <Section id={`${prefix}-environment`} title="Environmental checks">
        <ul className="space-y-1 text-sm">
          <li className="flex items-start gap-2">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
            <span>
              Flood: {FLOOD_LABELS[flood]}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
            <span>
              Title: {title === 'unable_to_assess' ? COPY.unableToAssess : humanizeKey(title)}
            </span>
          </li>
        </ul>
        {activeFlags.length > 0 ? (
          <ul className="space-y-1">
            {activeFlags.map((flag) => (
              <li key={flag.id} className="rounded-md border border-warning/50 bg-warning-soft p-2 text-sm">
                <span className="font-medium">{humanizeKey(flag.flagType)}</span>: {flag.note}
                {flag.validUntil ? <span className="text-xs text-fg-muted"> (until {formatDateLabel(flag.validUntil)})</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-fg-muted">
          Unknown flood or title status is not low risk; a site-level check is required before certifying safety.
        </p>
      </Section>

      <Section id={`${prefix}-actions`} title="Next actions">
        <div className="flex flex-wrap gap-2">
          <Button variant={compared ? 'primary' : 'secondary'} onClick={onToggleCompare} aria-pressed={compared} disabled={!compared && compareFull}>
            <Scale aria-hidden="true" className="h-4 w-4" />
            {compared ? 'Remove from comparison' : 'Compare'}
          </Button>
          <Button variant="secondary" onClick={onSaveScenario}>
            <Save aria-hidden="true" className="h-4 w-4" /> Save scenario
          </Button>
          <Button variant="secondary" onClick={onRequestVerification}>
            <ShieldQuestion aria-hidden="true" className="h-4 w-4" /> Request local verification
          </Button>
          <Link href={bookHref} className="inline-flex">
            <Button variant="primary">
              <CalendarCheck aria-hidden="true" className="h-4 w-4" /> Book consultation
            </Button>
          </Link>
        </div>
        <p className="text-xs text-fg-muted">
          <EvidenceBadge kind="user_assumption" /> figures come from your inputs; sourced and statewide figures keep their own badges.
        </p>
      </Section>
    </div>
  );
}

function PanelBody({ onSaveScenario, onRequestVerification }: { onSaveScenario: () => void; onRequestVerification: () => void }) {
  const { selectedSlug, rankedBySlug, recommendation, mode, setMode, calculators, compareSlugs, compareFull, toggleCompare, scenario } =
    useExplorer();
  const detail = useQuery({
    queryKey: ['explorer', 'market', selectedSlug],
    queryFn: ({ signal }) => getMarketDetail(selectedSlug as string, signal),
    enabled: selectedSlug !== null,
    staleTime: 5 * 60_000,
  });
  if (!selectedSlug) return null;
  if (detail.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading market details">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return <ErrorState title="Market details could not be loaded" error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  return (
    <LocationPanelContent
      detail={detail.data}
      ranked={rankedBySlug.get(selectedSlug) ?? null}
      recommendation={recommendation.data ?? null}
      mode={mode}
      calculators={calculators.data ?? null}
      compared={compareSlugs.includes(selectedSlug)}
      compareFull={compareFull}
      scenarioId={scenario.dto?.id ?? null}
      onToggleCompare={() => toggleCompare(selectedSlug)}
      onSaveScenario={onSaveScenario}
      onRequestVerification={onRequestVerification}
      onSwitchToAssumptions={() => setMode('assumption')}
    />
  );
}

export function LocationPanel({
  onSaveScenario,
  onRequestVerification,
}: {
  onSaveScenario: () => void;
  onRequestVerification: () => void;
}) {
  const { selectedSlug, selectedMarket, select, isDesktop, variant } = useExplorer();
  const inline = isDesktop && variant === 'full';
  const title = selectedMarket?.name ?? 'Market details';

  if (!inline) {
    return (
      <Dialog open={selectedSlug !== null} onOpenChange={(open) => !open && select(null)}>
        <DialogContent size="sheet" title={title} description={selectedMarket ? `${selectedMarket.stateName} · ${ZONE_LABELS[selectedMarket.geopoliticalZone]}` : undefined}>
          <PanelBody onSaveScenario={onSaveScenario} onRequestVerification={onRequestVerification} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <aside aria-labelledby="location-panel-heading" className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="location-panel-heading" className="text-lg font-semibold leading-tight">
          {selectedSlug ? title : 'Selected location'}
        </h2>
        {selectedSlug ? (
          <Button size="icon" variant="ghost" aria-label="Close location details" onClick={() => select(null)}>
            <X aria-hidden="true" className="h-5 w-5" />
          </Button>
        ) : null}
      </div>
      {selectedSlug ? (
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <PanelBody onSaveScenario={onSaveScenario} onRequestVerification={onRequestVerification} />
        </div>
      ) : (
        <EmptyState
          title="Select a market"
          description="Choose a marker on the map or a market in the results list to see its evidence, coverage and next actions."
        />
      )}
    </aside>
  );
}

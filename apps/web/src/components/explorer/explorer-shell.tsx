'use client';

import { ArrowRight, List, Map as MapIcon, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Alert, Button, NativeSelect, cn } from '@simplexd/ui';
import {
  COPY,
  OBJECTIVES,
  OBJECTIVE_LABELS,
  ZONES,
  ZONE_LABELS,
  buildExploreHref,
  type ExplorerView,
} from '@/lib/explorer';
import { CompareTray } from './compare-tray';
import { ComparisonDialog, type ReportBundle } from './comparison-view';
import { ComparisonReport } from './comparison-report';
import { useExplorer } from './explorer-context';
import { FilterPanel, FilterSheet } from './filter-panel';
import { LocationPanel } from './location-panel';
import { MapFrame } from './map-frame';
import { ModeSwitch } from './mode-switch';
import { PrioritiesPanel } from './priorities-panel';
import { ResultsList } from './results-list';
import { ScenarioActions } from './scenario-actions';
import { ScenarioBuilder } from './scenario-builder';

function ViewSwitch({
  view,
  onChange,
}: {
  view: ExplorerView;
  onChange: (view: ExplorerView) => void;
}) {
  const options: Array<{ value: ExplorerView; label: string; icon: typeof MapIcon }> = [
    { value: 'map', label: 'Map', icon: MapIcon },
    { value: 'list', label: 'List', icon: List },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Map or list view"
      className="inline-flex rounded-md border border-border bg-bg-elevated p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(value)}
            className={cn(
              'sx-transition sx-touch inline-flex items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:text-fg',
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ResultsSection({ limit, moreHref }: { limit?: number; moreHref?: string }) {
  const {
    rows,
    recommendation,
    selectedSlug,
    compareSlugs,
    compareFull,
    totalMarkets,
    markets,
    select,
    toggleCompare,
    setMode,
    resetFilters,
  } = useExplorer();
  return (
    <ResultsList
      rows={rows}
      recommendation={recommendation.data ?? null}
      selectedSlug={selectedSlug}
      compareSlugs={compareSlugs}
      compareFull={compareFull}
      totalCount={totalMarkets}
      loading={markets.isLoading}
      error={markets.error}
      onRetry={() => void markets.refetch()}
      onSelect={select}
      onToggleCompare={toggleCompare}
      onCompareWithAssumptions={() => setMode('assumption')}
      onResetFilters={resetFilters}
      limit={limit}
      moreHref={moreHref}
    />
  );
}

export function ExplorerShell() {
  const ctx = useExplorer();
  const {
    variant,
    params,
    mode,
    setMode,
    view,
    setView,
    filters,
    setFilters,
    priorities,
    setPriorities,
    recommendation,
    isDesktop,
    scenario,
    lastScenarioId,
    compareMarkets,
    rankedBySlug,
    assumptions,
    stateOptions,
  } = ctx;
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [report, setReport] = useState<ReportBundle | null>(null);
  const [prioritiesOpen, setPrioritiesOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const exploreHref = useMemo(() => buildExploreHref(params), [params]);
  const stateNames = useMemo(
    () => new Map(stateOptions.map((s) => [s.id, s.name])),
    [stateOptions],
  );

  const actions = (
    <ScenarioActions
      saveOpen={saveOpen}
      onSaveOpenChange={setSaveOpen}
      verificationOpen={verificationOpen}
      onVerificationOpenChange={setVerificationOpen}
      compact={variant === 'homepage'}
    />
  );
  const locationPanel = (
    <LocationPanel
      onSaveScenario={() => setSaveOpen(true)}
      onRequestVerification={() => setVerificationOpen(true)}
    />
  );
  const comparison = (
    <ComparisonDialog
      open={comparisonOpen}
      onOpenChange={setComparisonOpen}
      onReportGenerated={(bundle) => {
        setComparisonOpen(false);
        setReport(bundle);
      }}
    />
  );

  if (report) {
    return (
      <ComparisonReport
        generated={report.generated}
        comparison={report.comparison}
        markets={compareMarkets.map((m) => ({
          id: m.id,
          name: m.name,
          stateName: m.stateName,
          parentMarketId: m.parentMarketId,
          overlapNote: m.overlapNote,
        }))}
        rankedBySlug={rankedBySlug}
        filters={filters}
        priorities={priorities}
        assumptions={assumptions}
        mode={mode}
        stateNames={stateNames}
        onClose={() => setReport(null)}
      />
    );
  }

  const modeBanner =
    mode === 'assumption' ? (
      <Alert tone="warning" title="Assumption mode">
        {COPY.assumptionModeBanner}
        {variant === 'homepage' ? (
          <>
            {' '}
            <Link href={buildExploreHref(params, { mode: 'assumption' })} className="underline">
              Build the scenario in the full explorer
            </Link>
            .
          </>
        ) : null}
      </Alert>
    ) : null;

  const resumeBanner =
    lastScenarioId && !scenario.id && !params.shared && !params.scenario ? (
      <Alert tone="info" title="Resume your last saved scenario">
        <Link
          href={buildExploreHref(
            params,
            { scenario: lastScenarioId },
            variant === 'full' ? '/explore' : '/',
          )}
          className="underline"
        >
          Open the scenario saved on this device
        </Link>
      </Alert>
    ) : null;

  if (variant === 'homepage') {
    return (
      <section
        aria-labelledby="explorer-heading"
        className="space-y-4 rounded-lg border border-border bg-bg-elevated p-4 sm:p-6"
        data-testid="location-explorer"
        data-variant="homepage"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="explorer-heading" className="text-lg font-semibold">
              Explore where to build
            </h2>
            <p className="text-sm text-fg-muted">
              Fifty markets across all 36 states and the FCT. Badges show what is evidenced; unknown
              stays unknown, never an invented price.
            </p>
          </div>
          <Link
            href={exploreHref}
            className="sx-touch inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4"
          >
            Open full explorer <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="homepage-objective">
            Objective
          </label>
          <NativeSelect
            id="homepage-objective"
            className="w-auto"
            value={filters.objective}
            onChange={(event) =>
              setFilters({ objective: event.target.value as typeof filters.objective })
            }
          >
            {OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {OBJECTIVE_LABELS[o]}
              </option>
            ))}
          </NativeSelect>
          <ul className="flex flex-wrap gap-1" aria-label="Preferred regions">
            {ZONES.map((zone) => {
              const active = filters.preferredZones.includes(zone);
              return (
                <li key={zone}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setFilters({
                        preferredZones: active
                          ? filters.preferredZones.filter((z) => z !== zone)
                          : [...filters.preferredZones, zone],
                      })
                    }
                    className={cn(
                      'sx-transition sx-touch rounded-full border px-3 text-sm',
                      active
                        ? 'border-primary bg-primary-soft text-primary'
                        : 'border-border text-fg-muted hover:text-fg',
                    )}
                  >
                    {ZONE_LABELS[zone]}
                  </button>
                </li>
              );
            })}
          </ul>
          <ModeSwitch mode={mode} onChange={setMode} />
          <ViewSwitch view={view} onChange={setView} />
          <FilterSheet />
        </div>
        {modeBanner}
        {resumeBanner}
        {view === 'map' ? <MapFrame /> : null}
        <ResultsSection limit={6} moreHref={exploreHref} />
        {actions}
        <CompareTray onOpenComparison={() => setComparisonOpen(true)} />
        {comparison}
        {locationPanel}
      </section>
    );
  }

  return (
    <div className="space-y-4" data-testid="location-explorer" data-variant="full">
      <div className="flex flex-wrap items-center gap-2">
        <ModeSwitch mode={mode} onChange={setMode} />
        <ViewSwitch view={view} onChange={setView} />
        <div className="lg:hidden">
          <FilterSheet />
        </div>
        <Button
          variant="secondary"
          aria-expanded={prioritiesOpen}
          aria-controls="priorities-region"
          onClick={() => setPrioritiesOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" /> Priorities
        </Button>
        {recommendation.data ? (
          <p className="text-xs text-fg-muted">
            Policy v{recommendation.data.policyVersion}
            {recommendation.data.rankingEnabled ? '' : ' · financial ranking off'}
          </p>
        ) : null}
      </div>
      {modeBanner}
      {resumeBanner}
      {recommendation.data && recommendation.data.policyErrors.length > 0 ? (
        <Alert tone="warning" title="Some metrics are disabled by the ranking policy">
          <ul className="list-disc pl-5">
            {recommendation.data.policyErrors.map((e) => (
              <li key={`${e.metric ?? 'policy'}-${e.message}`}>
                {e.metric ? `${e.metric}: ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)_380px]">
        <aside aria-label="Filters" className="hidden lg:block">
          <div className="rounded-lg border border-border bg-bg-elevated p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <FilterPanel />
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          {view === 'map' ? <MapFrame /> : null}
          <ResultsSection />
        </div>
        <div className="space-y-4">
          {isDesktop ? locationPanel : null}
          <div
            id="priorities-region"
            hidden={!prioritiesOpen}
            className="rounded-lg border border-border bg-bg-elevated p-4"
          >
            <PrioritiesPanel
              priorities={priorities}
              objective={filters.objective}
              onChange={setPriorities}
              effectiveWeights={recommendation.data?.effectiveWeights ?? null}
            />
          </div>
          <div className="rounded-lg border border-border bg-bg-elevated p-4">{actions}</div>
        </div>
      </div>
      {mode === 'assumption' ? <ScenarioBuilder /> : null}
      <CompareTray onOpenComparison={() => setComparisonOpen(true)} />
      {comparison}
      {!isDesktop ? locationPanel : null}
    </div>
  );
}

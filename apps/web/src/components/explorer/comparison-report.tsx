'use client';

import { ArrowLeft, ExternalLink, Printer } from 'lucide-react';
import { Alert, Button } from '@simplexd/ui';
import { formatDateTimeLabel } from '@simplexd/ui/format';
import type { ComparisonResponse, ExplorerFilters, Priorities, RankedMarketDto, ScenarioAssumptions } from '@simplexd/contracts';
import {
  COPY,
  OBJECTIVE_LABELS,
  describeFilters,
  describePriorities,
  formatScenarioNaira,
  overlapWarnings,
  type ExplorerMode,
} from '@/lib/explorer';
import { ComparisonTable } from './comparison-view';
import type { GeneratedReport } from './use-scenario';

/**
 * Printable dated comparison report: policy version, generation date,
 * snapshot reference, inputs (filters, priorities, assumptions), the
 * comparison table and the disclaimers. The explorer chrome is hidden while
 * the report is open so the browser's print produces the report alone.
 */

export interface ComparisonReportProps {
  generated: GeneratedReport;
  comparison: ComparisonResponse | null;
  markets: Array<{ id: string; name: string; stateName: string; parentMarketId: string | null; overlapNote?: string | null }>;
  rankedBySlug: ReadonlyMap<string, RankedMarketDto>;
  filters: ExplorerFilters;
  priorities: Priorities;
  assumptions: ScenarioAssumptions;
  mode: ExplorerMode;
  stateNames: ReadonlyMap<string, string>;
  onClose: () => void;
}

export function ComparisonReport({
  generated,
  comparison,
  markets,
  rankedBySlug,
  filters,
  priorities,
  assumptions,
  mode,
  stateNames,
  onClose,
}: ComparisonReportProps) {
  const { scenario, snapshot, report } = generated;
  const json = report.kind === 'json' ? report : null;
  const table = json?.comparison ?? comparison;
  const title = json?.title ?? table?.reportTitle ?? 'Dated comparison report';
  const generatedAt = json?.generatedAt ?? snapshot.generatedAt ?? table?.generatedAt ?? new Date().toISOString();
  const policyVersion = json?.policyVersion ?? snapshot.policyVersion ?? table?.policyVersion ?? scenario.policyVersion;
  const warnings = overlapWarnings(markets);
  const base = assumptions.base;
  const disclaimers = [
    ...(json?.disclaimers ?? []),
    COPY.scenarioDisclaimer,
    'Statewide observations are context, not city values; unknown values were left unknown, never estimated.',
    'Sponsored placements, if any, are labelled and never alter fit scores.',
    'Figures reflect the policy version and source versions stored in the snapshot; later data changes do not alter this report.',
  ];

  return (
    <article aria-labelledby="comparison-report-title" className="space-y-6 rounded-lg border border-border bg-bg-elevated p-4 sm:p-6" data-testid="comparison-report">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" onClick={onClose}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to explorer
        </Button>
        <div className="flex gap-2">
          {report.kind === 'document' ? (
            <a href={report.url} target="_blank" rel="noopener noreferrer" className="inline-flex">
              <Button variant="secondary">
                <ExternalLink aria-hidden="true" className="h-4 w-4" /> Open server report
              </Button>
            </a>
          ) : null}
          <Button onClick={() => window.print()}>
            <Printer aria-hidden="true" className="h-4 w-4" /> Print or save as PDF
          </Button>
        </div>
      </div>

      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">SimplexD · dated comparison report</p>
        <h1 id="comparison-report-title" className="font-display text-2xl font-semibold">
          {title}
        </h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-fg-muted">Generated</dt>
          <dd>{formatDateTimeLabel(generatedAt)}</dd>
          <dt className="text-fg-muted">Policy version</dt>
          <dd>{policyVersion ?? 'not stated'}</dd>
          <dt className="text-fg-muted">Scenario</dt>
          <dd>
            {scenario.name} <span className="text-fg-muted">({scenario.id})</span>
          </dd>
          <dt className="text-fg-muted">Snapshot</dt>
          <dd>{json?.snapshotId ?? snapshot.snapshotId ?? 'recorded with the scenario'}</dd>
          <dt className="text-fg-muted">Mode</dt>
          <dd>{mode === 'assumption' ? 'Assumption mode (scenario, not an evidence-backed ranking)' : 'Evidence mode'}</dd>
        </dl>
      </header>

      <section aria-labelledby="report-inputs" className="space-y-2">
        <h2 id="report-inputs" className="text-lg font-semibold">
          Inputs
        </h2>
        <ul className="list-disc pl-5 text-sm">
          <li>Markets: {markets.map((m) => `${m.name} (${m.stateName})`).join(', ')}</li>
          <li>Objective: {OBJECTIVE_LABELS[filters.objective]}</li>
          {describeFilters(filters, stateNames)
            .filter((line) => !line.startsWith('Objective:'))
            .map((line) => (
              <li key={line}>{line}</li>
            ))}
          <li>Priorities: {describePriorities(priorities)}</li>
        </ul>
        {mode === 'assumption' ? (
          <div className="text-sm">
            <p className="font-medium">Base assumptions (your inputs)</p>
            <ul className="list-disc pl-5">
              <li>Land cost: {formatScenarioNaira(base.landCostNaira)}</li>
              <li>
                Build: {base.boqTotalNaira !== null ? `priced BOQ ${formatScenarioNaira(base.boqTotalNaira)}` : `${base.grossFloorAreaM2 ?? '—'} m² × ${formatScenarioNaira(base.buildRateNairaPerM2)} per m²`}
              </li>
              <li>
                Units: {base.units.length === 0 ? 'none' : base.units.map((u) => `${u.count} × ${u.label} at ${formatScenarioNaira(u.annualRentPerUnitNaira)}/year`).join('; ')}
              </li>
              <li>Vacancy {Math.round(base.vacancyRate * 100)}% · collection loss {Math.round(base.collectionLossRate * 100)}%</li>
              <li>Construction {base.constructionMonths} months · completion delay {base.completionDelayMonths} months</li>
              {assumptions.low ? <li>Low set overrides: {Object.keys(assumptions.low).join(', ')}</li> : null}
              {assumptions.high ? <li>High set overrides: {Object.keys(assumptions.high).join(', ')}</li> : null}
              {assumptions.notes ? <li>Notes: {assumptions.notes}</li> : null}
            </ul>
          </div>
        ) : null}
      </section>

      {warnings.length > 0 ? (
        <Alert tone="warning" title="Overlapping markets">
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <section aria-labelledby="report-table" className="space-y-2">
        <h2 id="report-table" className="text-lg font-semibold">
          Comparison
        </h2>
        {table ? (
          <ComparisonTable comparison={table} rankedBySlug={rankedBySlug} />
        ) : (
          <p className="text-sm text-fg-muted">The comparison table was not available when this report was generated.</p>
        )}
      </section>

      <section aria-labelledby="report-disclaimers" className="space-y-2">
        <h2 id="report-disclaimers" className="text-lg font-semibold">
          Disclaimers
        </h2>
        <ul className="list-disc pl-5 text-sm text-fg-muted">
          {disclaimers.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}

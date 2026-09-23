'use client';

import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { Alert, Button, Dialog, DialogContent, EvidenceBadge, Skeleton } from '@simplexd/ui';
import { formatDateLabel, formatDateTimeLabel } from '@simplexd/ui/format';
import type { ComparisonResponse, RankedMarketDto } from '@simplexd/contracts';
import {
  COPY,
  FLOOD_LABELS,
  floodStatusOf,
  formatMetricValue,
  overlapWarnings,
  postComparison,
  statusSummary,
  type ComparisonRequest,
} from '@/lib/explorer';
import { ErrorState } from './error-state';
import { useExplorer } from './explorer-context';
import type { GeneratedReport } from './use-scenario';

/**
 * Comparison of two to four markets: every cell shows the underlying value
 * and unit, its evidence badge, evidence date, confidence and geographic
 * scope. Statewide observations are labelled statewide context.
 */

export interface ReportBundle {
  generated: GeneratedReport;
  comparison: ComparisonResponse | null;
}

const isStatewide = (cell: ComparisonResponse['rows'][number]['cells'][number]): boolean =>
  cell.badge === 'regional_context' ||
  (cell.geographicScope ?? '').toLowerCase().includes('statewide') ||
  (cell.geographicScope ?? '').toLowerCase().includes('state_or_fct');

export function ComparisonTable({
  comparison,
  rankedBySlug,
}: {
  comparison: ComparisonResponse;
  rankedBySlug?: ReadonlyMap<string, RankedMarketDto>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border" data-testid="comparison-table">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">
          Comparison of {comparison.markets.length} markets under policy version{' '}
          {comparison.policyVersion}, generated {formatDateTimeLabel(comparison.generatedAt)}
        </caption>
        <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
          <tr>
            <th scope="col" className="sticky left-0 bg-bg-sunken px-3 py-2 font-medium">
              Metric
            </th>
            {comparison.markets.map((market) => (
              <th
                key={market.marketId}
                scope="col"
                className="px-3 py-2 font-medium normal-case tracking-normal"
              >
                <span className="text-sm text-fg">{market.name}</span>
                <span className="block text-xs">{market.stateName}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rankedBySlug ? (
            <tr className="border-t border-border">
              <th
                scope="row"
                className="sticky left-0 bg-bg-elevated px-3 py-2 text-left font-medium"
              >
                Ranking status
              </th>
              {comparison.markets.map((market) => {
                const ranked = rankedBySlug.get(market.slug) ?? null;
                const summary = statusSummary(ranked, null);
                return (
                  <td key={market.marketId} className="px-3 py-2 align-top">
                    <span className="font-medium">{summary.label}</span>
                    {summary.detail ? (
                      <span className="block text-xs text-fg-muted">{summary.detail}</span>
                    ) : null}
                    {ranked ? (
                      <span className="block text-xs text-fg-muted">
                        Flood: {FLOOD_LABELS[floodStatusOf({ metrics: {} }, ranked)]}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ) : null}
          {comparison.rows.map((row) => (
            <tr key={row.metric} className="border-t border-border">
              <th
                scope="row"
                className="sticky left-0 bg-bg-elevated px-3 py-2 text-left font-medium"
              >
                {row.label}
              </th>
              {comparison.markets.map((market) => {
                const cell = row.cells.find((c) => c.marketId === market.marketId);
                if (!cell) {
                  return (
                    <td key={market.marketId} className="px-3 py-2 align-top text-fg-muted">
                      Unknown
                    </td>
                  );
                }
                const statewide = isStatewide(cell);
                return (
                  <td key={market.marketId} className="px-3 py-2 align-top">
                    <span className="block font-semibold tabular-nums">
                      {formatMetricValue(cell.value, cell.unit)}
                    </span>
                    <span className="mt-0.5 block">
                      <EvidenceBadge kind={cell.badge} showDescription />
                    </span>
                    {statewide ? (
                      <span className="block text-xs font-medium text-warning">
                        {COPY.statewideContext}
                      </span>
                    ) : cell.geographicScope ? (
                      <span className="block text-xs text-fg-muted">{cell.geographicScope}</span>
                    ) : null}
                    <span className="block text-xs text-fg-muted">
                      {cell.evidenceDate
                        ? `Evidence ${formatDateLabel(cell.evidenceDate)}`
                        : 'Undated'}{' '}
                      · confidence{' '}
                      {cell.confidence !== null ? `${Math.round(cell.confidence * 100)}%` : '—'}
                    </span>
                    {cell.label ? (
                      <span className="block text-xs text-fg-muted">{cell.label}</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ComparisonDialog({
  open,
  onOpenChange,
  onReportGenerated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReportGenerated: (bundle: ReportBundle) => void;
}) {
  const { compareMarkets, filters, mode, priorities, assumptions, rankedBySlug, scenario } =
    useExplorer();
  const ids = useMemo(() => compareMarkets.map((m) => m.id), [compareMarkets]);
  const body = useMemo<ComparisonRequest>(
    () => ({
      marketIds: ids,
      objective: filters.objective,
      mode,
      priorities,
      assumptions: mode === 'assumption' ? assumptions : null,
      ...(scenario.dto ? { scenarioId: scenario.dto.id } : {}),
    }),
    [ids, filters.objective, mode, priorities, assumptions, scenario.dto],
  );
  const comparison = useQuery({
    queryKey: ['explorer', 'comparison', body],
    queryFn: ({ signal }) => postComparison(body, signal),
    enabled: open && ids.length >= 2 && ids.length <= 4,
    staleTime: 60_000,
    retry: 1,
  });
  const clientWarnings = overlapWarnings(compareMarkets);
  const serverWarnings = comparison.data?.overlapWarnings.map((w) => w.message) ?? [];
  const warnings = [...new Set([...serverWarnings, ...clientWarnings])];

  const generate = async () => {
    const generated = await scenario.generateReport();
    if (generated) onReportGenerated({ generated, comparison: comparison.data ?? null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={`Compare ${compareMarkets.map((m) => m.name).join(', ')}`}
        description={
          mode === 'assumption'
            ? 'Assumption mode: your inputs and model estimates count. Results are scenarios, not evidence-backed rankings.'
            : 'Evidence mode: each cell shows the underlying unit, evidence date, confidence and geographic scope.'
        }
      >
        <div className="space-y-3">
          {warnings.length > 0 ? (
            <Alert tone="warning" title="Overlapping markets">
              <ul className="list-disc pl-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {comparison.isLoading ? (
            <div role="status" aria-label="Loading comparison" className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : null}
          {comparison.error ? (
            <ErrorState
              title="The comparison could not be computed"
              error={comparison.error}
              onRetry={() => void comparison.refetch()}
            />
          ) : null}
          {comparison.data ? (
            <>
              <ComparisonTable comparison={comparison.data} rankedBySlug={rankedBySlug} />
              <p className="text-xs text-fg-muted">
                Policy version {comparison.data.policyVersion} · generated{' '}
                {formatDateTimeLabel(comparison.data.generatedAt)}. Unknown cells are unknown: no
                value was invented. {COPY.scenarioDisclaimer}
              </p>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void generate()}
              loading={scenario.busy === 'reporting'}
              loadingLabel="Generating report…"
              disabled={!comparison.data}
            >
              <FileText aria-hidden="true" className="h-4 w-4" /> Generate dated comparison report
            </Button>
            <span className="text-xs text-fg-muted">
              Saves the scenario, stores a snapshot of the policy version, inputs and source
              versions, and opens a printable report.
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

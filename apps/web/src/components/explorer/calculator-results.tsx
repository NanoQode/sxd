import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { Alert, EvidenceBadge, Skeleton } from '@simplexd/ui';
import { formatNumber, formatPercent } from '@simplexd/ui/format';
import {
  COPY,
  formatMonthIndex,
  formatScenarioNaira,
  formatYears,
  humanizeKey,
  numberResult,
  type CalcResult,
  type CalculatorRunResult,
  type LongLetView,
} from '@/lib/explorer';
import { ErrorState } from './error-state';

// The charting library is large; load it only when a sensitivity grid is shown.
const SensitivityChart = dynamic(
  () => import('./sensitivity-chart').then((m) => m.SensitivityChart),
  { loading: () => <Skeleton className="h-64 w-full" label="Loading sensitivity chart" /> },
);

/**
 * Calculator output tables. Every figure is a scenario under the user's
 * assumptions; failed calculations show their reason instead of a number.
 */

function Money({ value }: { value: number | null | undefined }) {
  return <span className="tabular-nums">{formatScenarioNaira(value)}</span>;
}

function ResultCell({
  result,
  render,
}: {
  result: CalcResult<number> | undefined;
  render: (value: number) => ReactNode;
}) {
  if (!result) return <span className="text-fg-muted">—</span>;
  return result.ok ? (
    <span className="tabular-nums">{render(result.value)}</span>
  ) : (
    <span className="text-fg-muted">{result.reason}</span>
  );
}

const IRR_REASONS: Record<string, string> = {
  irr_not_unique:
    'Not unique: the cash flows change sign more than once, so no single rate is reported.',
  irr_no_solution: 'No solution: the cash flows never change sign.',
};

export function DevelopmentCostCard({
  result,
}: {
  result: CalculatorRunResult['developmentCost'];
}) {
  if (!result.ok) {
    return (
      <Alert tone="info" title="Development cost not computed">
        {result.reason}
        {result.missing.length > 0 ? (
          <p className="mt-1">Missing: {result.missing.join(', ')}</p>
        ) : null}
      </Alert>
    );
  }
  const { value } = result;
  const inclusions = value.build.inclusions;
  return (
    <section aria-labelledby="calc-cost-heading" className="rounded-lg border border-border p-3">
      <h4 id="calc-cost-heading" className="text-sm font-semibold">
        Total development cost: <Money value={value.total} />
      </h4>
      <p className="text-xs text-fg-muted">
        Basis:{' '}
        {value.build.basis === 'boq'
          ? 'priced bill of quantities (the area-rate estimate is never added to it)'
          : 'gross floor area × approved build rate'}
        {value.build.areaRateCrossCheck !== null && value.build.areaRateCrossCheck !== undefined
          ? ` · area-rate cross-check ${formatScenarioNaira(value.build.areaRateCrossCheck)} (not added)`
          : ''}
        {inclusions
          ? ` · build figure ${[
              inclusions.roof ? 'includes roof' : 'excludes roof',
              inclusions.finishes ? 'includes finishes' : 'excludes finishes',
              inclusions.externalWorks ? 'includes external works' : 'excludes external works',
            ].join(', ')}${inclusions.notes ? ` (${inclusions.notes})` : ''}`
          : ''}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm sm:grid-cols-4">
        {(
          [
            ['Land', value.components.land],
            ['Acquisition costs', value.components.acquisitionCosts],
            ['Build cost', value.components.buildCost],
            ['Professional fees', value.components.professionalFees],
            ['Approvals', value.components.approvals],
            ['Utilities and external works', value.components.utilitiesAndExternalWorks],
            ['Contingency', value.components.contingency],
            ['Financing during build', value.components.financingDuringBuild],
          ] as const
        ).map(([label, amount]) => (
          <div key={label}>
            <dt className="text-xs text-fg-muted">{label}</dt>
            <dd>
              <Money value={amount} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const LONG_LET_ROWS: Array<{
  label: string;
  cell: (v: LongLetView) => ReactNode;
}> = [
  { label: 'Scheduled annual rent', cell: (v) => <Money value={v.scheduledAnnualRent} /> },
  {
    label: 'Effective income (after vacancy and collection loss)',
    cell: (v) => <Money value={v.effectiveIncome} />,
  },
  {
    label: 'Recurring operating expenses',
    cell: (v) => <Money value={v.operatingExpenses.total} />,
  },
  { label: 'Net operating income (pre-tax, before debt)', cell: (v) => <Money value={v.noi} /> },
  {
    label: 'Capex reserve',
    cell: (v) => (
      <span>
        <Money value={v.capexReserve ?? 0} />
        <span className="block text-xs text-fg-muted">
          {v.capexReserveTreatment === 'included_in_noi'
            ? 'included in NOI basis'
            : 'reported separately'}
        </span>
      </span>
    ),
  },
  {
    label: 'Tax (business-reviewed assumption)',
    cell: (v) => <Money value={v.tax?.amount ?? 0} />,
  },
  {
    label: 'Gross yield (denominator: development cost)',
    cell: (v) => (
      <ResultCell result={numberResult(v.grossYieldPercent)} render={(n) => formatPercent(n, 2)} />
    ),
  },
  {
    label: 'Net yield (denominator: development cost)',
    cell: (v) => (
      <ResultCell result={numberResult(v.netYieldPercent)} render={(n) => formatPercent(n, 2)} />
    ),
  },
  {
    label: 'Annual debt service (not an NOI expense)',
    cell: (v) => <Money value={v.annualDebtService} />,
  },
  { label: 'Cash flow after debt (pre-tax)', cell: (v) => <Money value={v.cashFlowAfterDebt} /> },
  {
    label: 'Simple payback',
    cell: (v) => (
      <ResultCell result={numberResult(v.simplePaybackYears)} render={(n) => formatYears(n)} />
    ),
  },
  {
    label: 'Cash-on-cash (explicit equity only)',
    cell: (v) =>
      v.cashOnCashPercent ? (
        <ResultCell
          result={numberResult(v.cashOnCashPercent)}
          render={(n) => formatPercent(n, 2)}
        />
      ) : (
        <span className="text-fg-muted">Needs equity</span>
      ),
  },
];

export function LongLetTable({
  sets,
  base,
}: {
  sets: CalculatorRunResult['sets'];
  base: CalculatorRunResult['longLet'];
}) {
  const columns: Array<{
    key: 'low' | 'base' | 'high';
    label: string;
    result: CalcResult<LongLetView>;
  }> = sets
    ? [
        { key: 'low', label: 'Low', result: sets.low },
        { key: 'base', label: 'Base', result: sets.base },
        { key: 'high', label: 'High', result: sets.high },
      ]
    : [{ key: 'base', label: 'Base', result: base }];
  const anyOk = columns.some((c) => c.result.ok);
  if (!anyOk) {
    return (
      <Alert tone="info" title="Rental economics not computed">
        {base.ok ? 'No usable set.' : base.reason}
        {!base.ok && base.missing.length > 0 ? (
          <p className="mt-1">Missing: {base.missing.join(', ')}</p>
        ) : null}
      </Alert>
    );
  }
  const denominator = columns.find((c) => c.result.ok)?.result;
  const denominatorLabel =
    denominator && denominator.ok
      ? humanizeKey(denominator.value.denominator.kind)
      : 'development cost';
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[520px] text-sm" data-testid="long-let-table">
        <caption className="px-3 py-2 text-left text-xs text-fg-muted">
          Long-let economics per input set. Yields divide by the {denominatorLabel.toLowerCase()}{' '}
          (the denominator), never by a market value.
        </caption>
        <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Figure
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-3 py-2 font-medium">
                {c.label} set
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LONG_LET_ROWS.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {row.label}
              </th>
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2 align-top">
                  {c.result.ok ? (
                    row.cell(c.result.value)
                  ) : (
                    <span className="text-xs text-fg-muted">Not computed: {c.result.reason}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
          {columns.some((c) => c.result.ok && c.result.value.denominator) ? (
            <tr className="border-t border-border">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                Denominator ({denominatorLabel.toLowerCase()})
              </th>
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2 align-top">
                  {c.result.ok ? <Money value={c.result.value.denominator.amount} /> : '—'}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function ShortStayTable({ result }: { result: CalculatorRunResult['shortStay'] }) {
  if (!result.ok) return null;
  const v = result.value;
  return (
    <section aria-labelledby="calc-short-stay" className="rounded-lg border border-border p-3">
      <h4 id="calc-short-stay" className="text-sm font-semibold">
        Short-stay economics (kept separate from annual leases)
      </h4>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-fg-muted">Available nights</dt>
          <dd>{formatNumber(v.availableNightsPerYear)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">
            Occupied nights ({Math.round(v.occupiedNightFraction * 100)}%)
          </dt>
          <dd>{formatNumber(v.occupiedNights, 1)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Gross booking revenue</dt>
          <dd>
            <Money value={v.grossBookingRevenue} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Platform charges</dt>
          <dd>
            <Money value={v.platformCharges} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">
            Cleaning ({formatNumber(v.numberOfStays, 1)} stays)
          </dt>
          <dd>
            <Money value={v.cleaningCosts} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Net operating income</dt>
          <dd>
            <Money value={v.netOperatingIncome} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Net yield (denominator: development cost)</dt>
          <dd>
            <ResultCell
              result={numberResult(v.netYieldPercent)}
              render={(n) => formatPercent(n, 2)}
            />
          </dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-fg-muted">
        Nightly rate × 365 is never used as revenue: only available, occupied nights count.
      </p>
    </section>
  );
}

export function ScheduleSummary({ result }: { result: CalculatorRunResult['phasing'] }) {
  if (!result.ok) {
    return <p className="text-sm text-fg-muted">Schedule not computed: {result.reason}</p>;
  }
  const s = result.value.schedule;
  const totals = result.value.totals;
  return (
    <section
      aria-labelledby="calc-schedule"
      className="rounded-lg border border-border p-3 text-sm"
    >
      <h4 id="calc-schedule" className="text-sm font-semibold">
        Expected schedule under your assumptions
      </h4>
      <p className="mt-1">
        Construction {s.constructionDurationMonths} months, then a completion delay of{' '}
        {s.completionDelayMonths} months: rental income starts in{' '}
        {formatMonthIndex(s.rentalStartIndex)} after start (
        {formatMonthIndex(s.plannedRentalStartIndex ?? s.constructionDurationMonths)} without
        delay).
      </p>
      {totals ? (
        <p className="mt-1 text-xs text-fg-muted">
          Over {result.value.months.length} months: rental income{' '}
          <Money value={totals.rentalIncome} />, operating expenses{' '}
          <Money value={totals.operatingExpenses} />, net cash flow{' '}
          <Money value={totals.netCashFlow} />.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-fg-muted">{COPY.notPromisedDate}</p>
    </section>
  );
}

export function NpvIrrRows({
  npv,
  irr,
}: {
  npv: CalculatorRunResult['npv'];
  irr: CalculatorRunResult['irr'];
}) {
  return (
    <section aria-labelledby="calc-npv" className="rounded-lg border border-border p-3 text-sm">
      <h4 id="calc-npv" className="text-sm font-semibold">
        NPV and IRR (explicit discount rate, exit value and selling costs)
      </h4>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-fg-muted">NPV</dt>
        <dd>
          {npv.ok ? (
            <span>
              <Money value={npv.value.npv} /> at {formatPercent(npv.value.discountRate * 100, 1)}{' '}
              per period
            </span>
          ) : (
            <span className="text-fg-muted">{npv.reason}</span>
          )}
        </dd>
        <dt className="text-fg-muted">IRR</dt>
        <dd>
          {irr.ok ? (
            <span>
              {formatPercent(irr.value.irr * 100, 2)} per period
              {irr.value.uniqueness && irr.value.uniqueness !== 'unique' ? (
                <span className="text-warning">
                  {' '}
                  (unverified: several sign changes; may not be unique)
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-fg-muted">{IRR_REASONS[irr.reason] ?? irr.reason}</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

export function CalculatorResults({
  result,
  loading,
  error,
  onRetry,
  usable,
  missing,
  showNpv,
}: {
  result: CalculatorRunResult | null;
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  usable: boolean;
  missing: string[];
  showNpv: boolean;
}) {
  if (!usable) {
    return (
      <Alert tone="info" title="Enter your assumptions to run the calculators">
        <p>Nothing is defaulted: no Nigerian averages are assumed. Still needed:</p>
        <ul className="mt-1 list-disc pl-5">
          {missing.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Alert>
    );
  }
  if (error) {
    return <ErrorState title="The calculators could not run" error={error} onRetry={onRetry} />;
  }
  if (loading || !result) {
    return (
      <div role="status" aria-label="Running calculators" className="space-y-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (result.empty) {
    return (
      <Alert tone="warning" title="No calculator results were recognised">
        The calculator service responded, but not in a shape this page can read. Nothing has been
        estimated in its place.
      </Alert>
    );
  }
  return (
    <div className="space-y-3" data-testid="calculator-results">
      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <EvidenceBadge kind="user_assumption" showDescription />
        <EvidenceBadge kind="model_estimate" showDescription />
        {result.disclaimer ?? COPY.scenarioDisclaimer}
      </p>
      <DevelopmentCostCard result={result.developmentCost} />
      <LongLetTable sets={result.sets} base={result.longLet} />
      <ShortStayTable result={result.shortStay} />
      <ScheduleSummary result={result.phasing} />
      {showNpv ? <NpvIrrRows npv={result.npv} irr={result.irr} /> : null}
      {result.sensitivity.ok ? (
        <SensitivityChart grid={result.sensitivity.value} />
      ) : (
        <p className="text-sm text-fg-muted">
          Sensitivity not computed: {result.sensitivity.reason}
        </p>
      )}
    </div>
  );
}

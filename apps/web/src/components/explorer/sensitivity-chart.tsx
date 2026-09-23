'use client';

import { useId, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button, NativeSelect } from '@simplexd/ui';
import { formatPercent } from '@simplexd/ui/format';
import { useTheme } from '@simplexd/ui/theme';
import {
  SENSITIVITY_VARIABLES,
  formatMultiplier,
  formatScenarioNaira,
  sensitivitySeries,
  type SensitivityVariable,
  type SensitivityView,
} from '@/lib/explorer';

/**
 * Net yield against one varied input at a time (vacancy, rents, costs,
 * interest, completion delay). One series per chart, so the title names it
 * and no legend is needed; the table below carries the same data for
 * screen readers and print.
 */

const VARIABLE_LABELS: Record<
  SensitivityVariable,
  { title: string; axis: string; format: (x: number) => string }
> = {
  vacancy: {
    title: 'Vacancy rate',
    axis: 'Vacancy rate',
    format: (x) => formatPercent(x * 100, 0),
  },
  rents: { title: 'Rent level', axis: 'Rent vs base', format: formatMultiplier },
  costs: { title: 'Development cost', axis: 'Cost vs base', format: formatMultiplier },
  interest: {
    title: 'Interest rate',
    axis: 'Annual interest',
    format: (x) => formatPercent(x * 100, 1),
  },
  completionDelayMonths: {
    title: 'Completion delay',
    axis: 'Delay (months)',
    format: (x) => `${x} mo`,
  },
};

export function SensitivityChart({ grid }: { grid: SensitivityView }) {
  const available = SENSITIVITY_VARIABLES.filter((v) => grid[v].length > 0);
  const [variable, setVariable] = useState<SensitivityVariable>(available[0] ?? 'vacancy');
  const [showTable, setShowTable] = useState(false);
  const { reducedMotion } = useTheme();
  const selectId = useId();
  const tableId = useId();
  const active = available.includes(variable) ? variable : (available[0] ?? 'vacancy');
  const meta = VARIABLE_LABELS[active];
  const points = sensitivitySeries(grid[active]).map((p) => ({ ...p, label: meta.format(p.x) }));
  const failed = points.filter((p) => p.netYield === null);

  if (available.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No sensitivity dimensions were computed for this scenario.
      </p>
    );
  }

  return (
    <section
      aria-labelledby={`${selectId}-heading`}
      className="rounded-lg border border-border p-3"
      data-testid="sensitivity-chart"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h4 id={`${selectId}-heading`} className="text-sm font-semibold">
            Sensitivity: net yield vs {meta.title.toLowerCase()}
          </h4>
          <p className="text-xs text-fg-muted">
            One input varied at a time, everything else at the base set. Denominator: development
            cost.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor={selectId} className="block text-xs font-medium">
              Varied input
            </label>
            <NativeSelect
              id={selectId}
              className="w-auto"
              value={active}
              onChange={(event) => setVariable(event.target.value as SensitivityVariable)}
            >
              {available.map((v) => (
                <option key={v} value={v}>
                  {VARIABLE_LABELS[v].title}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            variant="secondary"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((s) => !s)}
          >
            {showTable ? 'Hide table' : 'Show as table'}
          </Button>
        </div>
      </div>
      {grid.interest.length === 0 ? (
        <p className="mt-1 text-xs text-fg-muted">
          Interest sensitivity needs loan terms, which are not part of this scenario&apos;s inputs.
        </p>
      ) : null}
      <div
        className="mt-2 h-60 w-full"
        role="img"
        aria-label={`Line chart of net yield percent against ${meta.title.toLowerCase()}; the table has the same values.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--sx-chart-grid)" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="var(--sx-fg-muted)"
              tick={{ fill: 'var(--sx-fg-muted)', fontSize: 12 }}
              tickLine={false}
              label={{
                value: meta.axis,
                position: 'insideBottom',
                offset: -2,
                fill: 'var(--sx-fg-muted)',
                fontSize: 12,
              }}
            />
            <YAxis
              stroke="var(--sx-fg-muted)"
              tick={{ fill: 'var(--sx-fg-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              cursor={{ stroke: 'var(--sx-border-strong)', strokeWidth: 1 }}
              contentStyle={{
                background: 'var(--sx-bg-elevated)',
                border: '1px solid var(--sx-border)',
                borderRadius: 8,
                color: 'var(--sx-fg)',
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--sx-fg-muted)' }}
              itemStyle={{ color: 'var(--sx-fg)' }}
              formatter={(value) => [
                typeof value === 'number' ? formatPercent(value, 2) : 'not computed',
                'Net yield',
              ]}
            />
            <Line
              type="monotone"
              dataKey="netYield"
              name="Net yield"
              stroke="var(--sx-chart-1)"
              strokeWidth={2}
              dot={{
                r: 4,
                fill: 'var(--sx-chart-1)',
                stroke: 'var(--sx-bg-elevated)',
                strokeWidth: 2,
              }}
              activeDot={{ r: 6 }}
              connectNulls={false}
              isAnimationActive={!reducedMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {failed.length > 0 ? (
        <p className="mt-1 text-xs text-fg-muted">
          Not computed for {failed.map((p) => p.label).join(', ')}:{' '}
          {failed[0]?.reason ?? 'no result'}.
        </p>
      ) : null}
      <div id={tableId} hidden={!showTable} className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Net yield and cash flow after debt for each {meta.title.toLowerCase()} value
          </caption>
          <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              <th scope="col" className="px-2 py-1 font-medium">
                {meta.axis}
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Net yield
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                Cash flow after debt
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label} className="border-t border-border">
                <th scope="row" className="px-2 py-1 text-left font-medium">
                  {p.label}
                </th>
                <td className="px-2 py-1 tabular-nums">
                  {p.netYield === null
                    ? (p.reason ?? 'not computed')
                    : formatPercent(p.netYield, 2)}
                </td>
                <td className="px-2 py-1 tabular-nums">
                  {p.cashFlowAfterDebt === null ? '—' : formatScenarioNaira(p.cashFlowAfterDebt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

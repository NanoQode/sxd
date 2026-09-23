'use client';

import { RotateCcw } from 'lucide-react';
import { Button } from '@simplexd/ui';
import type { MetricKey, Objective, Priorities } from '@simplexd/contracts';
import { DEFAULT_WEIGHT_PERCENT, METRIC_KEYS, METRIC_LABELS, priorityOrDefault } from '@/lib/explorer';

/**
 * Scoring priorities: a 0–1 multiplier per metric applied to the policy's
 * default weights before renormalisation. The defaults are the brief's
 * proposed product defaults, not researched investment truths.
 */
export function PrioritiesPanel({
  priorities,
  objective,
  onChange,
  effectiveWeights,
}: {
  priorities: Priorities;
  objective: Objective;
  onChange: (priorities: Priorities) => void;
  /** Renormalised weights reported by the ranking service, when available. */
  effectiveWeights?: Partial<Record<MetricKey, number>> | null;
}) {
  const update = (metric: MetricKey, value: number) => {
    const next: Priorities = { ...priorities };
    if (value === 1) delete next[metric];
    else next[metric] = value;
    onChange(next);
  };
  const hasChanges = Object.keys(priorities).length > 0;
  return (
    <section aria-labelledby="priorities-heading" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="priorities-heading" className="text-sm font-semibold">
            Scoring priorities
          </h3>
          <p className="text-xs text-fg-muted">
            Each slider scales a metric&apos;s proposed default weight (shown in brackets); the
            ranking service renormalises the result. Defaults are product proposals, not researched
            investment truths.
          </p>
        </div>
        <Button variant="ghost" onClick={() => onChange({})} disabled={!hasChanges} aria-label="Reset priorities to defaults">
          <RotateCcw aria-hidden="true" className="h-4 w-4" /> Reset
        </Button>
      </div>
      <ul className="space-y-3">
        {METRIC_KEYS.map((metric) => {
          const omitted = objective === 'owner_occupation' && metric === 'net_rental_economics';
          const value = priorityOrDefault(priorities, metric);
          const id = `priority-${metric}`;
          const effective = effectiveWeights?.[metric];
          return (
            <li key={metric}>
              <label htmlFor={id} className="flex items-center justify-between text-sm">
                <span>
                  {METRIC_LABELS[metric]}{' '}
                  <span className="text-fg-muted">({DEFAULT_WEIGHT_PERCENT[metric]}%)</span>
                </span>
                <output htmlFor={id} className="tabular-nums text-fg-muted">
                  ×{value.toFixed(2)}
                  {typeof effective === 'number' ? ` → ${Math.round(effective * 100)}%` : ''}
                </output>
              </label>
              <input
                id={id}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={value}
                disabled={omitted}
                aria-valuetext={`${Math.round(value * 100)} percent of the default weight`}
                onChange={(event) => update(metric, Number(event.target.value))}
                className="mt-1 h-11 w-full accent-[var(--sx-primary)]"
              />
              {omitted ? (
                <p className="text-xs text-fg-muted">
                  Omitted for owner occupation; the remaining weights are renormalised.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

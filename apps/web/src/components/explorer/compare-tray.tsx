'use client';

import { Scale, X } from 'lucide-react';
import { Alert, Button } from '@simplexd/ui';
import { MAX_COMPARE, canCompare, overlapWarnings } from '@/lib/explorer';
import { useExplorer } from './explorer-context';

/** Comparison tray: up to four markets, with the Lagos/Ikeja/Ikorodu overlap warning. */
export function CompareTray({ onOpenComparison }: { onOpenComparison: () => void }) {
  const { compareSlugs, compareMarkets, toggleCompare, clearCompare } = useExplorer();
  if (compareSlugs.length === 0) return null;
  const warnings = overlapWarnings(compareMarkets);
  const ready = canCompare(compareSlugs);
  return (
    <div
      role="region"
      aria-label="Comparison tray"
      className="sticky bottom-0 z-20 rounded-lg border border-border bg-bg-elevated p-3 shadow-lg"
      data-testid="compare-tray"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          Compare ({compareSlugs.length}/{MAX_COMPARE})
        </span>
        <ul className="flex flex-wrap gap-1" aria-label="Markets in the comparison">
          {compareSlugs.map((slug) => {
            const market = compareMarkets.find((m) => m.slug === slug);
            return (
              <li key={slug} className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-sunken pl-3 text-sm">
                {market?.name ?? slug}
                <button
                  type="button"
                  className="sx-touch inline-flex items-center justify-center rounded-full text-fg-muted hover:text-fg"
                  aria-label={`Remove ${market?.name ?? slug} from the comparison`}
                  onClick={() => toggleCompare(slug)}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={clearCompare}>
            Clear
          </Button>
          <Button onClick={onOpenComparison} disabled={!ready} title={ready ? undefined : 'Add at least one more market'}>
            <Scale aria-hidden="true" className="h-4 w-4" /> Compare
          </Button>
        </div>
      </div>
      {!ready ? <p className="mt-1 text-xs text-fg-muted">Add at least one more market to compare (up to four).</p> : null}
      {warnings.length > 0 ? (
        <Alert tone="warning" title="Overlapping markets" className="mt-2">
          <ul className="list-disc pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

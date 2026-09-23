'use client';

import dynamic from 'next/dynamic';
import { List, Map as MapIcon, Maximize2, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Button, cn } from '@simplexd/ui';
import { useTheme } from '@simplexd/ui/theme';
import {
  COPY,
  FRESHNESS_LEGEND,
  getMapConfig,
  styleUrlForTheme,
  type MarketFeature,
  type MapConfig,
} from '@/lib/explorer';
import { useExplorer } from './explorer-context';
import { MAP_HEIGHT_CLASS } from './layout-constants';
import { StaticPreview } from './static-preview';

const MapView = dynamic(() => import('./map-view'), { ssr: false, loading: () => null });

/** Legend: colour plus words, so the map is never colour alone. */
export function MapLegend({ className }: { className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs', className)} aria-label="Map legend">
      {(['fresh', 'stale', 'unknown'] as const).map((key) => (
        <li key={key} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-full border border-bg-elevated"
            style={{
              background:
                key === 'fresh'
                  ? 'var(--sx-map-marker)'
                  : key === 'stale'
                    ? 'var(--sx-badge-stale)'
                    : 'var(--sx-badge-unknown)',
            }}
          />
          {FRESHNESS_LEGEND[key]}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-fg-on-primary"
          style={{ background: 'var(--sx-map-cluster)' }}
        >
          n
        </span>
        Grouped markets: zoom in to separate
      </li>
    </ul>
  );
}

/** Honest state for a missing licensed tile provider; the list remains fully functional. */
export function MapNotConfiguredPanel({ onUseList }: { onUseList?: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <Alert tone="info" title={COPY.mapNotConfigured} className="max-w-md bg-bg-elevated">
        <p>{COPY.mapNotConfiguredDetail}</p>
        {onUseList ? (
          <div className="mt-2">
            <Button variant="secondary" onClick={onUseList}>
              <List aria-hidden="true" className="h-4 w-4" /> Use the results list
            </Button>
          </div>
        ) : null}
      </Alert>
    </div>
  );
}

export function MapErrorPanel({
  error,
  onRetry,
  onUseList,
}: {
  error: Error;
  onRetry: () => void;
  onUseList: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <Alert tone="danger" title={COPY.mapFailed} className="max-w-md bg-bg-elevated">
        <p>{error.message || 'The map style or tiles could not be loaded.'}</p>
        <p className="mt-1">The results list below has the same functionality.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onRetry}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" /> Retry map
          </Button>
          <Button variant="ghost" onClick={onUseList}>
            <List aria-hidden="true" className="h-4 w-4" /> Use the list
          </Button>
        </div>
      </Alert>
    </div>
  );
}

export function MapFrame({ config: configOverride }: { config?: MapConfig }) {
  const { variant, visibleGeoJson, selectedSlug, compareSlugs, select, setView, markets } =
    useExplorer();
  const { resolvedTheme, reducedMotion } = useTheme();
  const config = useMemo(() => configOverride ?? getMapConfig(), [configOverride]);
  const styleUrl = styleUrlForTheme(config, resolvedTheme);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);

  const features: readonly MarketFeature[] = visibleGeoJson?.features ?? [];
  const onReady = useCallback(() => setReady(true), []);
  const onError = useCallback((e: Error) => {
    setError(e);
    setReady(false);
  }, []);
  const retry = useCallback(() => {
    setError(null);
    setReady(false);
    setAttempt((n) => n + 1);
  }, []);
  const useList = useCallback(() => setView('list'), [setView]);

  const status = !config.configured
    ? undefined
    : error
      ? undefined
      : markets.isLoading
        ? 'Loading markets…'
        : 'Loading interactive map…';

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'relative overflow-hidden rounded-lg border border-border bg-bg-sunken',
          MAP_HEIGHT_CLASS[variant],
        )}
      >
        {!ready || error || !config.configured ? (
          <StaticPreview
            features={features}
            selectedSlug={selectedSlug}
            compareSlugs={compareSlugs}
            status={status}
            className="absolute inset-0"
          />
        ) : null}
        {!config.configured ? (
          <MapNotConfiguredPanel onUseList={useList} />
        ) : error ? (
          <MapErrorPanel error={error} onRetry={retry} onUseList={useList} />
        ) : styleUrl && visibleGeoJson ? (
          <div
            className={cn(
              'sx-transition-base absolute inset-0',
              ready ? 'opacity-100' : 'opacity-0',
            )}
            aria-busy={!ready}
          >
            <MapView
              key={attempt}
              styleUrl={styleUrl}
              attribution={config.attribution}
              geojson={visibleGeoJson}
              selectedSlug={selectedSlug}
              compareSlugs={compareSlugs}
              reducedMotion={reducedMotion}
              themeKey={resolvedTheme}
              fitRequest={fitRequest}
              onSelect={select}
              onReady={onReady}
              onError={onError}
            />
          </div>
        ) : null}
        {ready && !error && config.configured ? (
          <div className="absolute top-2 left-2 flex gap-1">
            <Button
              size="icon"
              variant="secondary"
              aria-label="Zoom to the markets that match your filters"
              title="Zoom to results"
              onClick={() => setFitRequest((n) => n + 1)}
            >
              <Maximize2 aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MapLegend />
        <p className="flex items-center gap-1 text-xs text-fg-muted">
          <MapIcon aria-hidden="true" className="h-3.5 w-3.5" />
          Points are reference coordinates, not parcels or boundaries.
        </p>
      </div>
    </div>
  );
}

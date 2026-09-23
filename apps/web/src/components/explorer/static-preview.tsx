import { cn } from '@simplexd/ui';
import {
  FRESHNESS_LEGEND,
  NIGERIA_FRAME,
  ZONE_LABELS,
  projectToViewBox,
  type MarketFeature,
  type Zone,
} from '@/lib/explorer';

/**
 * Lightweight, server-renderable preview shown before (and instead of) the
 * MapLibre bundle: market points plotted on a plain longitude/latitude grid.
 * It deliberately draws no boundary — Nigeria's outline comes from the
 * licensed tile provider, never from memory.
 */

const BOX = { width: 630, height: 515 };

const FRESHNESS_FILL: Record<'fresh' | 'stale' | 'unknown', string> = {
  fresh: 'var(--sx-map-marker)',
  stale: 'var(--sx-badge-stale)',
  unknown: 'var(--sx-badge-unknown)',
};

function gridLines(): Array<{ kind: 'lon' | 'lat'; value: number; x?: number; y?: number }> {
  const [minLon, minLat, maxLon, maxLat] = NIGERIA_FRAME;
  const lines: Array<{ kind: 'lon' | 'lat'; value: number; x?: number; y?: number }> = [];
  for (let lon = Math.ceil(minLon / 2) * 2; lon <= maxLon; lon += 2) {
    lines.push({ kind: 'lon', value: lon, x: projectToViewBox(lon, minLat, BOX).x });
  }
  for (let lat = Math.ceil(minLat / 2) * 2; lat <= maxLat; lat += 2) {
    lines.push({ kind: 'lat', value: lat, y: projectToViewBox(minLon, lat, BOX).y });
  }
  return lines;
}

function zoneCentroids(features: readonly MarketFeature[]): Array<{ zone: Zone; x: number; y: number }> {
  const sums = new Map<Zone, { lon: number; lat: number; n: number }>();
  for (const feature of features) {
    const zone = feature.properties.zone;
    const [lon, lat] = feature.geometry.coordinates;
    const current = sums.get(zone) ?? { lon: 0, lat: 0, n: 0 };
    sums.set(zone, { lon: current.lon + lon, lat: current.lat + lat, n: current.n + 1 });
  }
  return [...sums.entries()].map(([zone, { lon, lat, n }]) => {
    const point = projectToViewBox(lon / n, lat / n, BOX);
    return { zone, x: point.x, y: point.y };
  });
}

export function StaticPreview({
  features,
  selectedSlug = null,
  compareSlugs = [],
  status,
  className,
}: {
  features: readonly MarketFeature[];
  selectedSlug?: string | null;
  compareSlugs?: readonly string[];
  /** Short status line, e.g. "Loading interactive map…". */
  status?: string;
  className?: string;
}) {
  const lines = gridLines();
  const centroids = zoneCentroids(features);
  const label =
    features.length === 0
      ? 'Static preview: longitude and latitude grid, markets not loaded yet'
      : `Static preview: ${features.length} markets plotted on a longitude and latitude grid`;
  return (
    <div className={cn('relative h-full w-full bg-bg-sunken', className)} data-testid="static-preview">
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        role="img"
        aria-label={label}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
      >
        <rect x="0" y="0" width={BOX.width} height={BOX.height} fill="var(--sx-bg-sunken)" />
        {lines.map((line) =>
          line.kind === 'lon' ? (
            <g key={`lon-${line.value}`}>
              <line
                x1={line.x}
                y1={0}
                x2={line.x}
                y2={BOX.height}
                stroke="var(--sx-chart-grid)"
                strokeWidth="1"
              />
              <text x={(line.x ?? 0) + 3} y={BOX.height - 6} fontSize="11" fill="var(--sx-fg-subtle)">
                {line.value}°E
              </text>
            </g>
          ) : (
            <g key={`lat-${line.value}`}>
              <line
                x1={0}
                y1={line.y}
                x2={BOX.width}
                y2={line.y}
                stroke="var(--sx-chart-grid)"
                strokeWidth="1"
              />
              <text x={4} y={(line.y ?? 0) - 3} fontSize="11" fill="var(--sx-fg-subtle)">
                {line.value}°N
              </text>
            </g>
          ),
        )}
        {centroids.map((c) => (
          <text
            key={c.zone}
            x={c.x}
            y={c.y - 14}
            fontSize="12"
            fontWeight="600"
            textAnchor="middle"
            fill="var(--sx-fg-muted)"
            opacity="0.8"
          >
            {ZONE_LABELS[c.zone]}
          </text>
        ))}
        {features.map((feature) => {
          const [lon, lat] = feature.geometry.coordinates;
          const point = projectToViewBox(lon, lat, BOX);
          const freshness = feature.properties.evidenceFreshness;
          const selected = feature.properties.slug === selectedSlug;
          const compared = compareSlugs.includes(feature.properties.slug);
          return (
            <g key={feature.properties.slug}>
              {selected || compared ? (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={selected ? 10 : 8}
                  fill="none"
                  stroke={selected ? 'var(--sx-map-marker-selected)' : 'var(--sx-teal)'}
                  strokeWidth="2.5"
                />
              ) : null}
              <circle
                cx={point.x}
                cy={point.y}
                r={5}
                fill={FRESHNESS_FILL[freshness]}
                stroke="var(--sx-bg-elevated)"
                strokeWidth="1.5"
              >
                <title>
                  {feature.properties.name}, {feature.properties.stateName} — {FRESHNESS_LEGEND[freshness]}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>
      <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-bg-elevated/85 px-3 py-1.5 text-xs text-fg-muted">
        {status ?? 'Static preview on a longitude/latitude grid; not a boundary map.'}
      </p>
    </div>
  );
}

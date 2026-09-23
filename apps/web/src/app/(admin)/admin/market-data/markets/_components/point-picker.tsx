'use client';

import { useId } from 'react';

const BBOX = { minLon: 2.5, maxLon: 15, minLat: 4, maxLat: 14 } as const;

export function insideNigeria(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= BBOX.minLon &&
    lon <= BBOX.maxLon &&
    lat >= BBOX.minLat &&
    lat <= BBOX.maxLat
  );
}

/**
 * Lightweight coordinate picker: the Nigeria bounding box drawn to scale with
 * the current point. Needs no tile provider, so it works without a map key;
 * the explorer's tiled map is not required to validate a reference point.
 */
export function NigeriaPointPicker({
  lon,
  lat,
  onChange,
}: {
  lon: number;
  lat: number;
  onChange?: (p: { lon: number; lat: number }) => void;
}) {
  const id = useId();
  const width = 400;
  const height = 320;
  const x = ((lon - BBOX.minLon) / (BBOX.maxLon - BBOX.minLon)) * width;
  const y = height - ((lat - BBOX.minLat) / (BBOX.maxLat - BBOX.minLat)) * height;
  const inside = insideNigeria(lon, lat);

  function fromEvent(e: React.MouseEvent<SVGSVGElement>) {
    if (!onChange) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const py = ((e.clientY - rect.top) / rect.height) * height;
    onChange({
      lon: BBOX.minLon + (px / width) * (BBOX.maxLon - BBOX.minLon),
      lat: BBOX.minLat + ((height - py) / height) * (BBOX.maxLat - BBOX.minLat),
    });
  }

  return (
    <figure className="max-w-md">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        className={
          onChange
            ? 'w-full cursor-crosshair rounded-md border border-border bg-bg-sunken'
            : 'w-full rounded-md border border-border bg-bg-sunken'
        }
        onClick={fromEvent}
      >
        <title id={`${id}-title`}>Reference point within the Nigeria bounding box</title>
        <desc id={`${id}-desc`}>
          Longitude {lon.toFixed(4)}, latitude {lat.toFixed(4)}; {inside ? 'inside' : 'outside'} the
          box.
        </desc>
        {[4, 6, 8, 10, 12, 14].map((l) => {
          const gy = height - ((l - BBOX.minLat) / (BBOX.maxLat - BBOX.minLat)) * height;
          return (
            <line
              key={`lat${l}`}
              x1={0}
              x2={width}
              y1={gy}
              y2={gy}
              stroke="var(--sx-border)"
              strokeDasharray="4 4"
            />
          );
        })}
        {[4, 6, 8, 10, 12, 14].map((l) => {
          const gx = ((l - BBOX.minLon) / (BBOX.maxLon - BBOX.minLon)) * width;
          return (
            <line
              key={`lon${l}`}
              y1={0}
              y2={height}
              x1={gx}
              x2={gx}
              stroke="var(--sx-border)"
              strokeDasharray="4 4"
            />
          );
        })}
        <rect
          x={1}
          y={1}
          width={width - 2}
          height={height - 2}
          fill="none"
          stroke="var(--sx-border-strong)"
        />
        {inside ? (
          <>
            <circle cx={x} cy={y} r={9} fill="var(--sx-map-marker-selected)" opacity={0.35} />
            <circle cx={x} cy={y} r={4} fill="var(--sx-map-marker)" />
          </>
        ) : null}
        <text x={6} y={14} fontSize={11} fill="var(--sx-fg-muted)">
          lon 2.5 → 15
        </text>
        <text x={6} y={height - 6} fontSize={11} fill="var(--sx-fg-muted)">
          lat 4 → 14
        </text>
      </svg>
      <figcaption className="mt-1 text-xs text-fg-muted">
        {inside
          ? `Point at ${lon.toFixed(4)}, ${lat.toFixed(4)}`
          : 'The point is outside Nigeria and cannot be saved.'}
      </figcaption>
    </figure>
  );
}

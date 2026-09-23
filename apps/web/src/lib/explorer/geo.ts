import type { MarketGeoJson, MarketSummaryDto } from '@simplexd/contracts';

/**
 * Geographic helpers. Coordinates are WGS84, longitude then latitude, exactly
 * as the API sends them. The bounding box below is only a viewport frame for
 * a longitude/latitude grid; it is not a boundary and nothing here draws one.
 */

export type MarketFeature = MarketGeoJson['features'][number];

/** Viewport frame: [minLon, minLat, maxLon, maxLat] comfortably containing all 50 markets. */
export const NIGERIA_FRAME: readonly [number, number, number, number] = [2.4, 3.9, 15.0, 14.2];

export function filterGeoJson(
  geojson: MarketGeoJson,
  visibleSlugs: ReadonlySet<string>,
): MarketGeoJson {
  return {
    type: 'FeatureCollection',
    features: geojson.features.filter((feature) => visibleSlugs.has(feature.properties.slug)),
  };
}

/** Builds the map layer from list summaries when the GeoJSON endpoint is unavailable. */
export function geoJsonFromMarkets(markets: readonly MarketSummaryDto[]): MarketGeoJson {
  return {
    type: 'FeatureCollection',
    features: markets.map((market) => ({
      type: 'Feature',
      id: market.slug,
      geometry: { type: 'Point', coordinates: [market.location.lon, market.location.lat] },
      properties: {
        id: market.id,
        slug: market.slug,
        name: market.name,
        stateName: market.stateName,
        zone: market.geopoliticalZone,
        serviceAvailability: market.serviceAvailability,
        recommendationStatus: market.recommendationStatus,
        evidenceFreshness: market.evidence.freshness,
        localObservations: market.evidence.localObservations,
        regionalContextObservations: market.evidence.regionalContextObservations,
        parentMarketId: market.parentMarketId,
      },
    })),
  };
}

export interface ViewBox {
  width: number;
  height: number;
}

/** Projects a lon/lat point onto an equirectangular SVG view box of the frame. */
export function projectToViewBox(
  lon: number,
  lat: number,
  box: ViewBox,
  frame: readonly [number, number, number, number] = NIGERIA_FRAME,
): { x: number; y: number } {
  const [minLon, minLat, maxLon, maxLat] = frame;
  const x = ((lon - minLon) / (maxLon - minLon)) * box.width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * box.height;
  return { x: round(x), y: round(y) };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Bounds of a feature set as [[minLon, minLat], [maxLon, maxLat]], or null when empty. */
export function boundsOf(
  features: readonly MarketFeature[],
): [[number, number], [number, number]] | null {
  if (features.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

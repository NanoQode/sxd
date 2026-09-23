'use client';

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import type { MarketGeoJson } from '@simplexd/contracts';
import { NIGERIA_FRAME, boundsOf, readMapColors, type MapColors } from '@/lib/explorer';

/**
 * MapLibre GL JS view of the markets. Loaded through next/dynamic (no SSR) so
 * the bundle never blocks the first paint. Markers cluster; unclustered points
 * are coloured by evidence freshness (the legend and the results list carry
 * the words). Any error before the style loads hands over to the list.
 */

export interface MapViewProps {
  styleUrl: string;
  attribution: string | null;
  geojson: MarketGeoJson;
  selectedSlug: string | null;
  compareSlugs: readonly string[];
  reducedMotion: boolean;
  /** Changes whenever the theme changes so layer colours are re-read. */
  themeKey: string;
  /** Increment to zoom the map to the visible markets. */
  fitRequest: number;
  onSelect: (slug: string) => void;
  onReady: () => void;
  onError: (error: Error) => void;
}

const SOURCE = 'sx-markets';
const LAYER = {
  clusters: 'sx-clusters',
  clusterCount: 'sx-cluster-count',
  compare: 'sx-compare',
  selected: 'sx-selected',
  points: 'sx-points',
  labels: 'sx-labels',
} as const;

const LOAD_TIMEOUT_MS = 20_000;

function styleFontStack(map: maplibregl.Map): string[] | null {
  const style = map.getStyle();
  if (!style?.glyphs) return null;
  for (const layer of style.layers ?? []) {
    if (layer.type === 'symbol') {
      const font = (layer.layout as { 'text-font'?: unknown } | undefined)?.['text-font'];
      if (Array.isArray(font) && font.every((f) => typeof f === 'string')) return font as string[];
    }
  }
  return ['Open Sans Regular', 'Arial Unicode MS Regular'];
}

function pointColorExpression(colors: MapColors): maplibregl.ExpressionSpecification {
  return [
    'match',
    ['get', 'evidenceFreshness'],
    'fresh',
    colors.fresh,
    'stale',
    colors.stale,
    colors.unknown,
  ];
}

function applyColors(map: maplibregl.Map, colors: MapColors): void {
  if (map.getLayer(LAYER.clusters)) {
    map.setPaintProperty(LAYER.clusters, 'circle-color', colors.cluster);
    map.setPaintProperty(LAYER.clusters, 'circle-stroke-color', colors.stroke);
  }
  if (map.getLayer(LAYER.clusterCount)) {
    map.setPaintProperty(LAYER.clusterCount, 'text-color', colors.text);
  }
  if (map.getLayer(LAYER.points)) {
    map.setPaintProperty(LAYER.points, 'circle-color', pointColorExpression(colors));
    map.setPaintProperty(LAYER.points, 'circle-stroke-color', colors.stroke);
  }
  if (map.getLayer(LAYER.selected)) {
    map.setPaintProperty(LAYER.selected, 'circle-stroke-color', colors.selected);
  }
  if (map.getLayer(LAYER.compare)) {
    map.setPaintProperty(LAYER.compare, 'circle-stroke-color', colors.compare);
  }
  if (map.getLayer(LAYER.labels)) {
    map.setPaintProperty(LAYER.labels, 'text-color', colors.fresh);
    map.setPaintProperty(LAYER.labels, 'text-halo-color', colors.stroke);
  }
}

function selectedFilter(slug: string | null): maplibregl.FilterSpecification {
  return ['==', ['get', 'slug'], slug ?? ''];
}

function compareFilter(slugs: readonly string[]): maplibregl.FilterSpecification {
  return ['in', ['get', 'slug'], ['literal', [...slugs]]];
}

interface LayerState {
  geojson: MarketGeoJson;
  selectedSlug: string | null;
  compareSlugs: readonly string[];
}

function ensureLayers(map: maplibregl.Map, state: LayerState): void {
  const colors = readMapColors(document.documentElement);
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, {
      type: 'geojson',
      data: state.geojson,
      cluster: true,
      clusterMaxZoom: 9,
      clusterRadius: 44,
      promoteId: 'slug',
    });
  }
  if (!map.getLayer(LAYER.clusters)) {
    map.addLayer({
      id: LAYER.clusters,
      type: 'circle',
      source: SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': colors.cluster,
        'circle-radius': ['step', ['get', 'point_count'], 16, 5, 20, 15, 26],
        'circle-stroke-width': 2,
        'circle-stroke-color': colors.stroke,
        'circle-opacity': 0.92,
      },
    });
  }
  const fonts = styleFontStack(map);
  if (fonts && !map.getLayer(LAYER.clusterCount)) {
    map.addLayer({
      id: LAYER.clusterCount,
      type: 'symbol',
      source: SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': fonts,
        'text-size': 12,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': colors.text },
    });
  }
  if (!map.getLayer(LAYER.compare)) {
    map.addLayer({
      id: LAYER.compare,
      type: 'circle',
      source: SOURCE,
      filter: compareFilter(state.compareSlugs),
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 3,
        'circle-stroke-color': colors.compare,
      },
    });
  }
  if (!map.getLayer(LAYER.selected)) {
    map.addLayer({
      id: LAYER.selected,
      type: 'circle',
      source: SOURCE,
      filter: selectedFilter(state.selectedSlug),
      paint: {
        'circle-radius': 14,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 3,
        'circle-stroke-color': colors.selected,
      },
    });
  }
  if (!map.getLayer(LAYER.points)) {
    map.addLayer({
      id: LAYER.points,
      type: 'circle',
      source: SOURCE,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': pointColorExpression(colors),
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': colors.stroke,
      },
    });
  }
  if (fonts && !map.getLayer(LAYER.labels)) {
    map.addLayer({
      id: LAYER.labels,
      type: 'symbol',
      source: SOURCE,
      minzoom: 6,
      filter: ['!', ['has', 'point_count']],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': fonts,
        'text-size': 12,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': colors.fresh,
        'text-halo-color': colors.stroke,
        'text-halo-width': 1.2,
      },
    });
  }
  applyColors(map, colors);
}

export default function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const propsRef = useRef(props);
  const styleRef = useRef(props.styleUrl);

  useEffect(() => {
    propsRef.current = props;
  });

  // Create the map once; the style is swapped in place when the theme changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: propsRef.current.styleUrl,
        bounds: [
          [NIGERIA_FRAME[0], NIGERIA_FRAME[1]],
          [NIGERIA_FRAME[2], NIGERIA_FRAME[3]],
        ],
        fitBoundsOptions: { padding: 24 },
        attributionControl: false,
        cooperativeGestures: true,
        minZoom: 4,
        maxZoom: 16,
        fadeDuration: propsRef.current.reducedMotion ? 0 : 300,
      });
    } catch (error) {
      propsRef.current.onError(
        error instanceof Error ? error : new Error('The map could not start in this browser.'),
      );
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        customAttribution: propsRef.current.attribution ?? undefined,
      }),
      'bottom-right',
    );

    const timeout = window.setTimeout(() => {
      if (!loadedRef.current) {
        propsRef.current.onError(new Error('Map tiles did not respond in time.'));
      }
    }, LOAD_TIMEOUT_MS);

    map.on('error', (event) => {
      if (!loadedRef.current) {
        const raw: unknown = event.error;
        propsRef.current.onError(
          raw instanceof Error
            ? raw
            : new Error(
                typeof (raw as { message?: unknown } | undefined)?.message === 'string'
                  ? String((raw as { message: string }).message)
                  : 'The map style could not be loaded.',
              ),
        );
      } else {
        console.warn('map error after load', event.error);
      }
    });
    map.on('load', () => {
      loadedRef.current = true;
      window.clearTimeout(timeout);
      propsRef.current.onReady();
    });
    map.on('style.load', () => {
      const current = propsRef.current;
      ensureLayers(map, {
        geojson: current.geojson,
        selectedSlug: current.selectedSlug,
        compareSlugs: current.compareSlugs,
      });
    });

    map.on('click', LAYER.clusters, (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: [LAYER.clusters] })[0];
      if (!feature || feature.geometry.type !== 'Point') return;
      const clusterId = feature.properties?.cluster_id as number | undefined;
      const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (clusterId === undefined || !source) return;
      const center = feature.geometry.coordinates as [number, number];
      source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => {
          map.easeTo({ center, zoom, duration: propsRef.current.reducedMotion ? 0 : 500 });
        })
        .catch(() => undefined);
    });
    map.on('click', LAYER.points, (event) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: [LAYER.points] })[0];
      const slug = feature?.properties?.slug;
      if (typeof slug === 'string') propsRef.current.onSelect(slug);
    });
    for (const layer of [LAYER.clusters, LAYER.points]) {
      map.on('mouseenter', layer, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    return () => {
      window.clearTimeout(timeout);
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // Theme: swap the style URL when it differs, otherwise just re-read the colours.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (styleRef.current !== props.styleUrl) {
      styleRef.current = props.styleUrl;
      map.setStyle(props.styleUrl);
      return;
    }
    if (map.isStyleLoaded()) applyColors(map, readMapColors(document.documentElement));
  }, [props.styleUrl, props.themeKey]);

  // Data
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(props.geojson);
  }, [props.geojson]);

  // Selection ring and gentle pan to the selected market
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(LAYER.selected))
      map.setFilter(LAYER.selected, selectedFilter(props.selectedSlug));
    if (!props.selectedSlug) return;
    const feature = props.geojson.features.find((f) => f.properties.slug === props.selectedSlug);
    if (!feature) return;
    map.easeTo({
      center: feature.geometry.coordinates,
      zoom: Math.max(map.getZoom(), 7),
      duration: props.reducedMotion ? 0 : 600,
    });
  }, [props.selectedSlug, props.geojson, props.reducedMotion]);

  // Comparison rings
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer(LAYER.compare))
      map.setFilter(LAYER.compare, compareFilter(props.compareSlugs));
  }, [props.compareSlugs]);

  // Zoom to the visible markets on request
  useEffect(() => {
    const map = mapRef.current;
    if (!map || props.fitRequest === 0) return;
    const bounds = boundsOf(props.geojson.features);
    if (!bounds) return;
    map.fitBounds(bounds, {
      padding: 48,
      maxZoom: 9,
      duration: props.reducedMotion ? 0 : 600,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitRequest]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      role="region"
      aria-label="Interactive map of Nigerian property markets. Markers cluster; select a marker to open its details. Keyboard users can use the results list for the same functionality."
      data-testid="map-view"
    />
  );
}

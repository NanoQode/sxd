/**
 * Map tile provider configuration for MapLibre GL JS.
 *
 * The brief requires a licensed tile provider with visible attribution and
 * configurable keys, and forbids public community tile servers as a
 * production backend. Style URLs (with their API keys) are public by nature
 * (NEXT_PUBLIC_*), so keys must be restricted to the site's origin in the
 * provider's dashboard. Tile/sprite/glyph hosts are extracted for the CSP
 * `connect-src`/`img-src` directives.
 */

export class MapProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapProviderError';
  }
}

/** Community/demo servers that must never back production traffic. */
export const COMMUNITY_TILE_HOST_SUFFIXES: readonly string[] = [
  'tile.openstreetmap.org',
  'openstreetmap.org',
  'tile.osm.org',
  'osm.org',
  'demotiles.maplibre.org',
  'tile.openstreetmap.fr',
  'tile.openstreetmap.de',
  'tiles.wmflabs.org',
];

/** Hosts with free tiers whose terms restrict production use; allowed but flagged. */
export const RESTRICTED_TILE_HOST_SUFFIXES: readonly string[] = ['basemaps.cartocdn.com'];

export type MapProviderKind =
  | 'maptiler'
  | 'stadia'
  | 'mapbox'
  | 'protomaps'
  | 'geoapify'
  | 'jawg'
  | 'thunderforest'
  | 'self-hosted'
  | 'other';

const PROVIDER_HOSTS: Record<Exclude<MapProviderKind, 'self-hosted' | 'other'>, string[]> = {
  maptiler: ['api.maptiler.com'],
  stadia: ['tiles.stadiamaps.com', 'tiles-eu.stadiamaps.com'],
  mapbox: ['api.mapbox.com', 'events.mapbox.com'],
  protomaps: ['api.protomaps.com'],
  geoapify: ['maps.geoapify.com'],
  jawg: ['tile.jawg.io', 'api.jawg.io'],
  thunderforest: ['tile.thunderforest.com'],
};

const PROVIDER_ATTRIBUTION: Record<Exclude<MapProviderKind, 'self-hosted' | 'other'>, string> = {
  maptiler:
    '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  stadia:
    '<a href="https://stadiamaps.com/" target="_blank" rel="noopener">&copy; Stadia Maps</a> <a href="https://openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  mapbox:
    '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">&copy; Mapbox</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  protomaps:
    '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  geoapify:
    'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  jawg: '<a href="https://www.jawg.io" target="_blank" rel="noopener">&copy; Jawg</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
  thunderforest:
    '<a href="https://www.thunderforest.com/" target="_blank" rel="noopener">&copy; Thunderforest</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
};

export const OSM_DATA_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isCommunityTileHost(hostname: string): boolean {
  return hostMatches(hostname, COMMUNITY_TILE_HOST_SUFFIXES);
}

export function isRestrictedTileHost(hostname: string): boolean {
  return hostMatches(hostname, RESTRICTED_TILE_HOST_SUFFIXES);
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new MapProviderError(`map style URL is not a valid absolute URL: ${url}`);
  }
}

export function detectMapProvider(url: string): MapProviderKind {
  const host = parseUrl(url).hostname.toLowerCase();
  for (const [kind, hosts] of Object.entries(PROVIDER_HOSTS) as Array<[MapProviderKind, string[]]>) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return kind;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return 'self-hosted';
  return 'other';
}

/**
 * Throws when the URL points at a known public community tile server. Call it
 * for every style/tile URL before production use.
 */
export function assertLicensedProvider(url: string, context = 'map style URL'): void {
  const parsed = parseUrl(url);
  if (isCommunityTileHost(parsed.hostname)) {
    throw new MapProviderError(
      `${context} uses ${parsed.hostname}, a public community tile server. Community and demo servers cannot be a production backend (their usage policies forbid it and they carry no SLA). Configure a licensed provider (MapTiler, Stadia Maps, Mapbox, Protomaps, Geoapify, Jawg, Thunderforest or a self-hosted tile server) with its own key; see docs/providers/maps.md.`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new MapProviderError(`${context} must use https (got ${parsed.protocol})`);
  }
}

export interface MapConfig {
  configured: boolean;
  styleUrlLight: string | null;
  styleUrlDark: string | null;
  /** HTML attribution to render visibly on the map (MapLibre attribution control). */
  attribution: string;
  /** Hostnames for CSP connect-src/img-src (styles, tiles, sprites, glyphs). */
  tileHosts: string[];
  provider: MapProviderKind | null;
  warnings: string[];
}

export interface ResolveMapConfigOptions {
  /** Defaults to env.APP_ENV. */
  appEnv?: string;
}

/**
 * Reads NEXT_PUBLIC_MAP_STYLE_URL, NEXT_PUBLIC_MAP_STYLE_URL_DARK,
 * NEXT_PUBLIC_MAP_ATTRIBUTION and MAP_TILE_HOSTS. In production a community
 * host or a non-https URL throws; elsewhere it is reported as a warning so
 * local development can use demo tiles.
 */
export function resolveMapConfig(
  env: Record<string, string | undefined>,
  options: ResolveMapConfigOptions = {},
): MapConfig {
  const appEnv = options.appEnv ?? env.APP_ENV ?? 'development';
  const production = appEnv === 'production';
  const light = env.NEXT_PUBLIC_MAP_STYLE_URL?.trim() || null;
  const dark = env.NEXT_PUBLIC_MAP_STYLE_URL_DARK?.trim() || null;
  const warnings: string[] = [];
  const hosts = new Set<string>();

  if (!light) {
    return {
      configured: false,
      styleUrlLight: null,
      styleUrlDark: null,
      attribution: env.NEXT_PUBLIC_MAP_ATTRIBUTION?.trim() || OSM_DATA_ATTRIBUTION,
      tileHosts: [],
      provider: null,
      warnings: ['NEXT_PUBLIC_MAP_STYLE_URL is not set; the map shows the list fallback'],
    };
  }

  let provider: MapProviderKind | null = null;
  for (const [label, url] of [
    ['NEXT_PUBLIC_MAP_STYLE_URL', light],
    ['NEXT_PUBLIC_MAP_STYLE_URL_DARK', dark],
  ] as const) {
    if (!url) continue;
    const parsed = parseUrl(url);
    if (production) {
      assertLicensedProvider(url, label);
    } else if (isCommunityTileHost(parsed.hostname)) {
      warnings.push(`${label} uses community tiles (${parsed.hostname}); allowed in ${appEnv} only`);
    } else if (parsed.protocol !== 'https:') {
      warnings.push(`${label} is not https; allowed in ${appEnv} only`);
    }
    if (isRestrictedTileHost(parsed.hostname)) {
      warnings.push(`${label} uses ${parsed.hostname}, whose free tier restricts commercial production use; confirm the licence`);
    }
    hosts.add(parsed.hostname.toLowerCase());
    provider ??= detectMapProvider(url);
  }

  if (provider && provider !== 'other' && provider !== 'self-hosted') {
    for (const host of PROVIDER_HOSTS[provider]) hosts.add(host);
  }
  for (const entry of (env.MAP_TILE_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host) hosts.add(host);
  }

  let attribution = env.NEXT_PUBLIC_MAP_ATTRIBUTION?.trim() || '';
  if (!attribution) {
    attribution =
      provider && provider !== 'other' && provider !== 'self-hosted'
        ? PROVIDER_ATTRIBUTION[provider]
        : OSM_DATA_ATTRIBUTION;
    if (provider === 'other') warnings.push('NEXT_PUBLIC_MAP_ATTRIBUTION is not set for an unrecognised provider; only the OpenStreetMap data credit is shown');
  }
  if (!dark) warnings.push('NEXT_PUBLIC_MAP_STYLE_URL_DARK is not set; the light style is used in dark mode');

  return {
    configured: true,
    styleUrlLight: light,
    styleUrlDark: dark ?? light,
    attribution,
    tileHosts: [...hosts].sort(),
    provider,
    warnings,
  };
}

/** CSP source list for the map hosts (https origins). */
export function mapCspSources(config: MapConfig): string[] {
  return config.tileHosts.map((host) => `https://${host}`);
}

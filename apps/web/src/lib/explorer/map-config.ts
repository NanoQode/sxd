/**
 * Map tile configuration. A licensed provider is configured through public
 * environment variables. When they are unset the explorer must not fall back
 * to public community tile servers: it renders an honest "not configured"
 * panel and the fully functional list instead.
 */

export interface MapConfig {
  configured: boolean;
  lightStyleUrl: string | null;
  darkStyleUrl: string | null;
  attribution: string | null;
}

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export function readMapConfig(env: {
  styleUrl?: string;
  darkStyleUrl?: string;
  attribution?: string;
}): MapConfig {
  const lightStyleUrl = clean(env.styleUrl);
  const darkStyleUrl = clean(env.darkStyleUrl) ?? lightStyleUrl;
  return {
    configured: lightStyleUrl !== null,
    lightStyleUrl,
    darkStyleUrl,
    attribution: clean(env.attribution),
  };
}

/** Reads NEXT_PUBLIC_* variables (inlined at build time by Next.js). */
export function getMapConfig(): MapConfig {
  return readMapConfig({
    styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    darkStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL_DARK,
    attribution: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION,
  });
}

export function styleUrlForTheme(config: MapConfig, theme: 'light' | 'dark'): string | null {
  return theme === 'dark' ? (config.darkStyleUrl ?? config.lightStyleUrl) : config.lightStyleUrl;
}

/** CSS custom properties that colour the map layers; read at runtime so themes apply. */
export const MAP_COLOR_VARS = {
  fresh: '--sx-map-marker',
  stale: '--sx-badge-stale',
  unknown: '--sx-badge-unknown',
  selected: '--sx-map-marker-selected',
  compare: '--sx-teal',
  cluster: '--sx-map-cluster',
  stroke: '--sx-bg-elevated',
  text: '--sx-fg-on-primary',
} as const;

export type MapColorKey = keyof typeof MAP_COLOR_VARS;
export type MapColors = Record<MapColorKey, string>;

const FALLBACK_COLORS: MapColors = {
  fresh: '#1f5f4b',
  stale: '#a8651a',
  unknown: '#6b716d',
  selected: '#c8a04b',
  compare: '#1f7a8c',
  cluster: '#1f7a8c',
  stroke: '#ffffff',
  text: '#ffffff',
};

/** Resolves the theme's colours from the document; falls back to the light palette. */
export function readMapColors(root?: Element | null): MapColors {
  if (typeof window === 'undefined' || !root) return { ...FALLBACK_COLORS };
  const styles = window.getComputedStyle(root);
  const out = { ...FALLBACK_COLORS };
  for (const key of Object.keys(MAP_COLOR_VARS) as MapColorKey[]) {
    const value = styles.getPropertyValue(MAP_COLOR_VARS[key]).trim();
    if (value !== '') out[key] = value;
  }
  return out;
}

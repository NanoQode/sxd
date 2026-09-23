import { describe, expect, it } from 'vitest';
import { MapProviderError, assertLicensedProvider, detectMapProvider, mapCspSources, resolveMapConfig } from './config';

describe('map provider policy', () => {
  it('rejects public community tile servers for production with a clear message', () => {
    for (const url of [
      'https://demotiles.maplibre.org/style.json',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.osm.org/{z}/{x}/{y}.png',
    ]) {
      expect(() => assertLicensedProvider(url), url).toThrow(MapProviderError);
      expect(() => assertLicensedProvider(url), url).toThrow(/community tile server.*licensed provider/);
    }
    expect(() => assertLicensedProvider('http://api.maptiler.com/maps/streets-v2/style.json?key=k')).toThrow(/https/);
    expect(() => assertLicensedProvider('https://api.maptiler.com/maps/streets-v2/style.json?key=k')).not.toThrow();
    expect(() => assertLicensedProvider('not a url')).toThrow(/valid absolute URL/);
  });

  it('resolves a MapTiler configuration with CSP hosts and attribution', () => {
    const config = resolveMapConfig({
      APP_ENV: 'production',
      NEXT_PUBLIC_MAP_STYLE_URL: 'https://api.maptiler.com/maps/streets-v2/style.json?key=KEY',
      NEXT_PUBLIC_MAP_STYLE_URL_DARK: 'https://api.maptiler.com/maps/streets-v2-dark/style.json?key=KEY',
      MAP_TILE_HOSTS: 'https://cdn.example.com/fonts, tiles.example.com',
    });
    expect(config.configured).toBe(true);
    expect(config.provider).toBe('maptiler');
    expect(config.tileHosts).toEqual(['api.maptiler.com', 'cdn.example.com', 'tiles.example.com']);
    expect(config.attribution).toContain('MapTiler');
    expect(config.attribution).toContain('OpenStreetMap contributors');
    expect(config.warnings).toEqual([]);
    expect(mapCspSources(config)).toEqual(['https://api.maptiler.com', 'https://cdn.example.com', 'https://tiles.example.com']);
  });

  it('throws in production but only warns in development for community tiles', () => {
    const env = { NEXT_PUBLIC_MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json' };
    expect(() => resolveMapConfig({ ...env, APP_ENV: 'production' })).toThrow(MapProviderError);
    const dev = resolveMapConfig({ ...env, APP_ENV: 'development' });
    expect(dev.configured).toBe(true);
    expect(dev.warnings.some((w) => /community tiles/.test(w))).toBe(true);
    expect(dev.styleUrlDark).toBe(env.NEXT_PUBLIC_MAP_STYLE_URL);
    expect(dev.provider).toBe('other');
  });

  it('reports an unconfigured map and detects providers', () => {
    const none = resolveMapConfig({ APP_ENV: 'production' });
    expect(none).toMatchObject({ configured: false, styleUrlLight: null, tileHosts: [], provider: null });
    expect(none.warnings[0]).toMatch(/NEXT_PUBLIC_MAP_STYLE_URL/);
    expect(detectMapProvider('https://tiles.stadiamaps.com/styles/alidade_smooth.json?api_key=k')).toBe('stadia');
    expect(detectMapProvider('https://api.mapbox.com/styles/v1/x/y?access_token=t')).toBe('mapbox');
    expect(detectMapProvider('https://tiles.simplexd.local/style.json')).toBe('self-hosted');
    const stadia = resolveMapConfig({ APP_ENV: 'staging', NEXT_PUBLIC_MAP_STYLE_URL: 'https://tiles.stadiamaps.com/styles/alidade_smooth.json?api_key=k' });
    expect(stadia.tileHosts).toEqual(['tiles-eu.stadiamaps.com', 'tiles.stadiamaps.com']);
    expect(stadia.attribution).toContain('Stadia Maps');
  });
});

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { ReactElement } from 'react';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');
import { COPY, geoJsonFromMarkets, readMapConfig } from '@/lib/explorer';
import { market } from '@/lib/explorer/test-fixtures';
import { MapNotConfiguredPanel } from './map-frame';
import { StaticPreview } from './static-preview';

describe('StaticPreview', () => {
  it('renders every market as a grid point with an accessible label and no boundary path', () => {
    const geojson = geoJsonFromMarkets([
      market({ slug: 'lagos', name: 'Lagos', location: { lon: 3.3936, lat: 6.4561 } }),
      market({
        slug: 'kano',
        name: 'Kano',
        stateName: 'Kano',
        geopoliticalZone: 'NW',
        location: { lon: 8.592, lat: 12.0022 },
      }),
    ]);
    const html = renderToString(
      createElement(StaticPreview, { features: geojson.features, selectedSlug: 'lagos' }),
    );
    expect(html).toContain('2 markets plotted on a longitude and latitude grid');
    expect(html).toContain('Lagos, Lagos — No local evidence yet');
    expect(html).toContain('North West');
    expect(html).not.toContain('<path');
    expect(html).toContain('not a boundary map');
  });
});

describe('map configuration', () => {
  it('never falls back to a public tile server when unset', () => {
    const config = readMapConfig({ styleUrl: '', darkStyleUrl: undefined, attribution: '' });
    expect(config).toEqual({
      configured: false,
      lightStyleUrl: null,
      darkStyleUrl: null,
      attribution: null,
    });
    const html = renderToString(createElement(MapNotConfiguredPanel, {}));
    expect(html).toContain(COPY.mapNotConfigured);
    expect(html).toContain('NEXT_PUBLIC_MAP_STYLE_URL');
  });

  it('uses the light style for dark mode when no dark style is configured', () => {
    const config = readMapConfig({
      styleUrl: 'https://tiles.example/light.json?key=k',
      attribution: '© Provider',
    });
    expect(config.configured).toBe(true);
    expect(config.darkStyleUrl).toBe('https://tiles.example/light.json?key=k');
  });
});

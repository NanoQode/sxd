# Map tiles (MapLibre GL JS)

Adapter: `packages/integrations/src/maps` (`resolveMapConfig`, `assertLicensedProvider`,
`mapCspSources`).

## Why a licensed provider

The brief requires a licensed tile provider with visible attribution and configurable keys.
Public community servers (`tile.openstreetmap.org`, `*.tile.osm.org`, `demotiles.maplibre.org`,
`tile.openstreetmap.fr`, …) forbid heavy/production use and carry no SLA. `resolveMapConfig`
throws `MapProviderError` in production for any style URL on those hosts (and for non-https
URLs); in development/test it only warns, so demo tiles can be used locally.

## Configuration

```
NEXT_PUBLIC_MAP_STYLE_URL=https://api.maptiler.com/maps/streets-v2/style.json?key=KEY
NEXT_PUBLIC_MAP_STYLE_URL_DARK=https://api.maptiler.com/maps/streets-v2-dark/style.json?key=KEY
NEXT_PUBLIC_MAP_ATTRIBUTION=            # optional; provider default is used when empty
MAP_TILE_HOSTS=                         # optional extra hosts for CSP (fonts/sprites CDN)
```

`resolveMapConfig(env)` returns `{ configured, styleUrlLight, styleUrlDark, attribution,
tileHosts[], provider, warnings[] }`. `tileHosts` (style URL hosts + provider-known tile hosts +
`MAP_TILE_HOSTS`) feed the CSP `connect-src`, `img-src` and `worker-src` directives via
`mapCspSources`. Without a style URL the map is `configured: false` and the explorer renders the
accessible list fallback with a retry.

The style URL (and therefore the key) is public. Restrict the key to the site's origins in the
provider dashboard and rotate it from Admin → Integrations → Maps (the same screen controls the
optional geocoding provider).

## Provider setup notes

| Provider                                                         | Style URL pattern                                                                                                                      | Key restriction                                                                           | Attribution (rendered by default)                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| MapTiler                                                         | `https://api.maptiler.com/maps/<style>/style.json?key=…`                                                                               | Account → API keys → allowed HTTP origins                                                 | © MapTiler © OpenStreetMap contributors                   |
| Stadia Maps                                                      | `https://tiles.stadiamaps.com/styles/<style>.json?api_key=…`                                                                           | Dashboard → domain allow-list (EU endpoint `tiles-eu.stadiamaps.com` also allowed in CSP) | © Stadia Maps © OpenMapTiles © OpenStreetMap contributors |
| Mapbox                                                           | `https://api.mapbox.com/styles/v1/<user>/<style>?access_token=…` (needs `mapbox://` resolution; prefer a MapLibre-compatible provider) | token URL restrictions                                                                    | © Mapbox © OpenStreetMap                                  |
| Protomaps (self-hosted PMTiles or API)                           | `https://api.protomaps.com/styles/…?key=…` or your own host                                                                            | your CDN                                                                                  | Protomaps © OpenStreetMap contributors                    |
| Geoapify / Jawg / Thunderforest                                  | see provider docs                                                                                                                      | domain allow-list                                                                         | provider + OSM credit                                     |
| Self-hosted (Martin/Tileserver-GL + OpenMapTiles/Protomaps data) | `https://tiles.<domain>/style.json`                                                                                                    | network                                                                                   | OpenMapTiles/OSM credit; check the data licence           |

Every provider above renders OpenStreetMap data: the "© OpenStreetMap contributors" credit is
mandatory (ODbL) and must stay visible; do not hide or collapse the attribution control on mobile
beyond MapLibre's compact mode.

## Nigeria boundaries

Boundaries and neighbourhood polygons come from reviewed PostGIS data (`markets`,
`neighbourhoods`), not from the tile provider, and are never fabricated from city points. Use
a style whose Nigeria rendering has been reviewed (state boundaries, disputed-border handling)
before launch.

## Launch dependency

Track "licensed map tile account" as an external launch input. Until it is provided the public
map runs on `demotiles.maplibre.org` in development only; staging/production refuse to start
the map with community tiles and fall back to the list view.

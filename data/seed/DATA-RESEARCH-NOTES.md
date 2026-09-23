# Nigeria market seed — research notes and publication rules

Research date: 22 September 2026.

## What this handoff does and does not contain

The JSON contains **50 mapped markets spanning all 36 states and the FCT**, **16 attributed price observations**, and **13 published cement/ready-mix facility references**. Sixteen of the 50 market records link to at least one price observation or state context. Only Ibadan has city-specific price observations in this seed; the remaining price records are statewide/FCT context. No city has a complete validated financial recommendation profile.

This is useful starting data for the portal, not a completed 50-city valuation survey. Current city-specific land prices, construction rates, supplier stock/delivery terms, approval processing times and rental projections were **not verified across all 50 locations**. Those fields are null rather than invented. None of the seed records is eligible for automatic financial ranking. The map can launch as an explorer and assumption-driven planner while SimplexD gathers local evidence.

Research checked public property-market reporting, a licensed geography dataset, manufacturers' published facility locations, an official flood-information source and integration documentation. It did not include field visits, supplier calls, official title searches, private transaction datasets or paid valuation reports. A source read is not a business/legal verification.

## Selection method

Use 36 state capitals plus Abuja to anchor national coverage, then add Lagos, Ikorodu, Epe, Sagamu, Ijebu-Ode, Ogbomoso, Ile-Ife, Onitsha, Nnewi, Aba, Warri, Zaria and Suleja as editorial additional markets. The user approved a major-market/geographic-coverage approach rather than population ranking. This selection is not an empirically ranked list of the country's 50 best investments. Future admin edits can replace/add markets without changing historical project IDs.

Lagos, Ikeja and Ikorodu have overlapping metropolitan geography. Their markers are separate search experiences, not disjoint market territories. Epe is a Lagos State market and should not inherit a precise Lagos-metropolis polygon. Every point is a reference coordinate, not a surveyed property location. Population figures were deliberately omitted because they are unnecessary for the requested functionality and can mix incompatible geographic definitions.

## Complete 50-market register

Coordinates are latitude, longitude in this human-readable table; the JSON correctly uses longitude, latitude in GeoJSON.

| #   | Market        | State/FCT                 | Zone | Reference coordinates | Price evidence included                      |
| --- | ------------- | ------------------------- | ---- | --------------------- | -------------------------------------------- |
| 1   | Abeokuta      | Ogun                      | SW   | 7.15, 3.35            | State context only                           |
| 2   | Abakaliki     | Ebonyi                    | SE   | 6.3333, 8.1           | No price benchmark found in reviewed sources |
| 3   | Abuja         | Federal Capital Territory | NC   | 9.0556, 7.4914        | State context only                           |
| 4   | Ado-Ekiti     | Ekiti                     | SW   | 7.6167, 5.2167        | No price benchmark found in reviewed sources |
| 5   | Akure         | Ondo                      | SW   | 7.25, 5.195           | No price benchmark found in reviewed sources |
| 6   | Asaba         | Delta                     | SS   | 6.1833, 6.75          | State context only                           |
| 7   | Awka          | Anambra                   | SE   | 6.2, 7.0667           | No price benchmark found in reviewed sources |
| 8   | Bauchi        | Bauchi                    | NE   | 10.3158, 9.8442       | No price benchmark found in reviewed sources |
| 9   | Benin City    | Edo                       | SS   | 6.3176, 5.6145        | State context only                           |
| 10  | Birnin Kebbi  | Kebbi                     | NW   | 12.4318, 4.1956       | No price benchmark found in reviewed sources |
| 11  | Calabar       | Cross River               | SS   | 4.95, 8.325           | No price benchmark found in reviewed sources |
| 12  | Damaturu      | Yobe                      | NE   | 11.7803, 11.9786      | No price benchmark found in reviewed sources |
| 13  | Dutse         | Jigawa                    | NW   | 11.7024, 9.334        | No price benchmark found in reviewed sources |
| 14  | Enugu         | Enugu                     | SE   | 6.4403, 7.4942        | State context only                           |
| 15  | Gombe         | Gombe                     | NE   | 10.2897, 11.1673      | No price benchmark found in reviewed sources |
| 16  | Gusau         | Zamfara                   | NW   | 12.1628, 6.6745       | No price benchmark found in reviewed sources |
| 17  | Ibadan        | Oyo                       | SW   | 7.3775, 3.9058        | City + state context                         |
| 18  | Ikeja         | Lagos                     | SW   | 6.6186, 3.3426        | State context only                           |
| 19  | Ilorin        | Kwara                     | NC   | 8.5, 4.55             | No price benchmark found in reviewed sources |
| 20  | Jalingo       | Taraba                    | NE   | 8.9195, 11.3264       | No price benchmark found in reviewed sources |
| 21  | Jos           | Plateau                   | NC   | 9.9333, 8.8833        | No price benchmark found in reviewed sources |
| 22  | Kaduna        | Kaduna                    | NW   | 10.5105, 7.4165       | No price benchmark found in reviewed sources |
| 23  | Kano          | Kano                      | NW   | 12.0022, 8.592        | No price benchmark found in reviewed sources |
| 24  | Katsina       | Katsina                   | NW   | 12.9889, 7.6008       | No price benchmark found in reviewed sources |
| 25  | Lafia         | Nasarawa                  | NC   | 8.5, 8.5167           | No price benchmark found in reviewed sources |
| 26  | Lokoja        | Kogi                      | NC   | 7.8019, 6.7442        | No price benchmark found in reviewed sources |
| 27  | Maiduguri     | Borno                     | NE   | 11.8333, 13.15        | No price benchmark found in reviewed sources |
| 28  | Makurdi       | Benue                     | NC   | 7.7306, 8.5361        | No price benchmark found in reviewed sources |
| 29  | Minna         | Niger                     | NC   | 9.6139, 6.5569        | No price benchmark found in reviewed sources |
| 30  | Osogbo        | Osun                      | SW   | 7.7597, 4.5761        | No price benchmark found in reviewed sources |
| 31  | Owerri        | Imo                       | SE   | 5.4833, 7.0333        | No price benchmark found in reviewed sources |
| 32  | Port Harcourt | Rivers                    | SS   | 4.7655, 7.0163        | State context only                           |
| 33  | Sokoto        | Sokoto                    | NW   | 13.0622, 5.2339       | No price benchmark found in reviewed sources |
| 34  | Umuahia       | Abia                      | SE   | 5.5333, 7.4833        | No price benchmark found in reviewed sources |
| 35  | Uyo           | Akwa Ibom                 | SS   | 5.05, 7.9333          | State context only                           |
| 36  | Yenagoa       | Bayelsa                   | SS   | 4.9267, 6.2676        | No price benchmark found in reviewed sources |
| 37  | Yola          | Adamawa                   | NE   | 9.2, 12.4833          | No price benchmark found in reviewed sources |
| 38  | Lagos         | Lagos                     | SW   | 6.4561, 3.3936        | State context only                           |
| 39  | Ikorodu       | Lagos                     | SW   | 6.6264, 3.5517        | State context only                           |
| 40  | Epe           | Lagos                     | SW   | 6.5833, 3.9833        | State context only                           |
| 41  | Sagamu        | Ogun                      | SW   | 6.8333, 3.65          | State context only                           |
| 42  | Ijebu-Ode     | Ogun                      | SW   | 6.8249, 3.9191        | State context only                           |
| 43  | Ogbomoso      | Oyo                       | SW   | 8.1333, 4.25          | State context only                           |
| 44  | Ile-Ife       | Osun                      | SW   | 7.4667, 4.5667        | No price benchmark found in reviewed sources |
| 45  | Onitsha       | Anambra                   | SE   | 6.1667, 6.7833        | No price benchmark found in reviewed sources |
| 46  | Nnewi         | Anambra                   | SE   | 6.0167, 6.9167        | No price benchmark found in reviewed sources |
| 47  | Aba           | Abia                      | SE   | 5.1167, 7.3667        | No price benchmark found in reviewed sources |
| 48  | Warri         | Delta                     | SS   | 5.5167, 5.75          | State context only                           |
| 49  | Zaria         | Kaduna                    | NW   | 11.0667, 7.7          | No price benchmark found in reviewed sources |
| 50  | Suleja        | Niger                     | NC   | 9.1806, 7.1794        | No price benchmark found in reviewed sources |

Zone abbreviations: SW South West, SE South East, SS South South, NC North Central, NW North West, NE North East.

## Sources and interpretation

### Geography

[Simplemaps Nigeria city subset](https://simplemaps.com/data/ng-cities) and its [JSON data](https://simplemaps.com/static/data/country-cities/ng/ng.json) provide the seed coordinates/state labels. The subset page explicitly offers its data under MIT terms. Attribution: Simplemaps / Pareto Software, LLC. Retain the supplied license notice when redistributing.

Normalize the source spelling Shagamu to Sagamu and keep Shagamu as an alias. Coordinates were selected from source records rather than guessed. No accuracy suitable for boundary adjudication, title investigation, routing or cadastral work is asserted. Validate geometry against an approved boundary layer before publishing.

### Property-market observations

Selected facts come from [Nigeria Property Centre's Q3 2026 report](https://nigeriapropertycentre.com/market-reports/q3-2026), retrieved 22 September, with source update shown as 21 September. Q3 had not ended, so every observation marks the reporting period incomplete.

The seed includes five state/FCT rent medians, nine sale medians and two Ibadan medians. They describe mixed advertised stock. They are neither transaction prices nor a matched portfolio for yield calculation. Sample counts are retained where captured; uncollected sample sizes remain null. Never divide mixed-stock rent and sale medians to make a rental-yield claim.

Limited factual research does not grant rights to copy the publisher's entire database or operate a scraper. Arrange a licensed feed or collect authorized first-party comparables before automated commercial ingestion. Store publication rights separately from factual review.

### Material access

Manufacturer sources: [Dangote Nigeria operations](https://www.dangotecement.com/nigeria-operations/), [Lafarge published plant locations](https://www.lafarge.com.ng/contact-us), and [BUA operations](https://buacement.com/operations).

The seed stores facility names and states. Links from a market to regional facilities are **editorial research leads**, not verified distribution routes, distance calculations, dealer appointments, stock reports or delivery promises. Cement plant proximity alone is not a materials-access score. Ready-mix service radius needs direct confirmation.

To activate materials comparison, collect cement, steel/rebar, sand, aggregate, blocks, timber, roofing, electrical and plumbing quotations as appropriate to the BOQ. Record exact specifications/units, supplier contact permission, taxes, freight, unloading, order quantity, route conditions, validity and lead time. Delivered cost and material quality matter more than factory distance. Avoid mixing a cement bag, tonne of steel and truckload of sand without explicit units.

### Flood, soil and infrastructure

[NIHSA](https://nihsa.gov.ng/) is a research source for flood information. No city risk label was assigned from its homepage. Official risk layers must be retrieved, dated, licensed where applicable and spatially matched before use. A broad administrative alert is not an individual parcel assessment.

Site suitability, drainage, soil, utility reliability, road access and security need locality-specific professional/operational evidence. Unknown does not mean safe. Do not assign broad security scores to cities from stereotypes or stale summaries. Keep subjective assessments separately attributed and dated.

### Timelines

No researched city-level tender, permit or construction-duration values are included. Bidding windows come from actual tenders; approval durations from the relevant authority and completed local cases; building duration from scope, resources and dependency schedules. The JSON's shared demonstration schedule is explicitly illustrative, incomplete and unsuitable for a promised completion date.

## Import contract

1. Validate `schema_version`, source IDs, unique market IDs, finite coordinates and country bounds.
2. Upsert sources and facility leads, then observations, then markets. Resolve links by stable IDs. Re-running the seed must not duplicate rows.
3. Convert whole-naira price observations to the application money representation only where appropriate. The JSON labels whole naira explicitly; it is not kobo. Do not reinterpret NGN/year as NGN/month.
4. Preserve nulls as unknown. Empty arrays mean no captured references, not zero market activity.
5. Keep observations in contextual panels. Their `rank_eligible: false` is a deliberate constraint.
6. Import market content as draft. Owner/operator review controls public visibility and actual service availability.
7. Do not overwrite human edits on repeat import. Store imported versions and surface conflicts for review.
8. Compute source freshness from observation/publication dates and policy; do not use import time to make old evidence fresh.
9. Do not expose incomplete demonstration defaults as real local estimates.
10. Preserve source references in exports, comparison reports and admin review views.

## Research completion plan inside the admin portal

Create one evidence-completion task set per market. A practical target is ten or more independent deduplicated property-type/neighborhood comparables, three current delivered supplier quotes per major material where feasible, a scoped quantity-surveyor estimate, authority-specific approval evidence and current environmental checks. These are proposed review thresholds, not guarantees of statistical representativeness.

Assign a responsible researcher and separate reviewer, budget, due date and evidence rights. Priority should follow real demand and operational coverage. A market becomes financial-ranking eligible only after the required evidence and coverage policy pass. Customers can still build explicitly assumption-based scenarios when local evidence is unavailable.

## Research limitations to preserve in the finished portal

- A visible map marker does not establish a staffed SimplexD operation in that location.
- An observed asking price is not a valuation, completed transaction or return promise.
- A material-supply lead is not a confirmed dealer quote or delivery route.
- A model schedule is not an official approval commitment.
- A source retrieval timestamp is not the date the underlying market was measured.
- No pooled-investment, lending or escrow product is authorized by this research.

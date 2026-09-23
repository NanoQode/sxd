# CMS: editing, publication and public rendering

Code: `apps/web/src/server/content/**` (workflow, public loaders, media, redirects),
`apps/web/src/app/(admin)/admin/content/**` (editor, redirects), `apps/web/src/app/(public)/**`
(rendering), `apps/web/src/components/public/site-content.ts` (pure mappers from published pages
to what the shell renders), `packages/contracts/src/content.ts` (schemas), `apps/web/src/proxy.ts`
(redirect resolution).

## 1. Workflow

Draft → in review → published (or scheduled), with revisions, rollback and separation of duties:
the person who publishes, schedules, approves or rolls back a revision must differ from its author
(`content.publish`). Scheduled pages become visible when `publishAt` passes (the worker also
materialises them). Every publication clears the public content cache (`cacheDelete('content')`),
so a change is live within seconds; loaders cache published pages for 60 seconds otherwise.

Markdown bodies are rendered through the sanitiser (`apps/web/src/lib/markdown.ts`): scripts,
event handlers, iframes, `javascript:` links and non-https image sources are removed at save time
and again at preview time. Structured data lives in each revision's `fields` (JSON), validated
per kind by the schemas below; a malformed `fields` object never breaks a page, the public site
falls back to its built-in defaults for that item.

Staff preview links (`/preview/content/{id}?rev=n`) require `content.edit` and are `noindex`.

## 2. What each kind renders

| Kind                                                                                   | Where it renders                                                                                                                      | Slug / fields contract                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banner`                                                                               | Announcement strip above the header on every public page                                                                              | `fields`: `message` (plain text; the sanitised body is used when empty), `href`, `linkLabel`, `tone` (`info`/`warning`/`success`), `startsAt`/`endsAt` (display window inside the publication window), `dismissible`. Dismissal is stored per visitor in `localStorage` keyed by slug + publication time, so a republish shows the banner again.                              |
| `navigation`                                                                           | Header links after the Services menu, mobile drawer links, footer columns                                                             | One page per slot. Slot from `fields.slot` or the slug (`header`, `header-secondary`, `footer-explore`, `footer-company`, or `navigation-<slot>`). `fields.items`: 1–12 `{ label, href }`; `href` is an app path or https URL. Slots without a published page keep the defaults in `nav-data.ts`. The Services mega-menu always lists the catalogue and is not editable here. |
| `goal_path`                                                                            | Homepage "Start from your goal" cards                                                                                                 | `fields.key` ∈ `buy_safely`, `build_with_oversight`, `manage_property`, `invest_and_compare`; title from the page title; `description`, `href`, `exploreHref`, `serviceSlugs` override the defaults. Unknown keys are ignored. Order follows the pages once all four are published.                                                                                           |
| `location_intro`                                                                       | `/locations/{marketSlug}`: "Introduction" section above the evidence profile; also feeds the page title/description when `seo` is set | Slug `location-intro-{marketSlug}` or `fields.marketSlug`. A published intro makes an otherwise evidence-less location page indexable (see §4).                                                                                                                                                                                                                               |
| `contact`                                                                              | Footer contact block, `/contact`                                                                                                      | Slug `contact`; `fields`: `email`, `phone`, `whatsapp`, `address`, `hours`, `responseTime`. Body renders on `/contact`. Without values the site shows "Contact details are being confirmed".                                                                                                                                                                                  |
| `policy`                                                                               | `/policies/{slug}`, footer links                                                                                                      | `fields.reviewStatus` = `reviewed` removes the "template pending legal review" notice and makes the page indexable; `effectiveDate`, `version`. `privacy` and `terms` fall back to built-in templates.                                                                                                                                                                        |
| `faq`, `evidence_standard`, `case_study`, `testimonial`, `resource`, `service`, `page` | Homepage sections, `/resources`, `/services`, audience pages                                                                          | As before; see the loaders in `apps/web/src/app/(public)/_lib/site-data.ts`.                                                                                                                                                                                                                                                                                                  |

Use "Insert … fields template" in the editor to get the shape for a kind.

## 3. Media

Uploads use the shared file pipeline (`docs/workflows/files.md`) with purpose `content_media`
(`content.media.manage`): quarantine → inspection → malware scan → WebP derivatives. The picker
in the editor ("Insert or upload media") shows three honest states:

1. **Awaiting approval**: scanning, clean-but-no-derivative-yet, rejected/infected with the
   reason, or clean and waiting for a second content editor. The uploader can never approve their
   own image; approval (`POST /api/v1/files/{id}/public-approval`) requires alt text and a rights
   confirmation and records a `media_assets` row.
2. **Approved**: assets with their public URL, `/media/{assetId}` (thumbnail
   `?variant=thumb`). "Insert" adds `![alt](/media/{assetId})` to the body.
3. Private evidence, documents and video originals are never listed and never served.

`GET /media/{assetId}` (`apps/web/src/app/media/[id]/route.ts`) streams the WebP derivative only
when the file is `content_media`, scanned `clean`, promoted out of quarantine, and approved on
both the file and the media asset; otherwise 404. Responses carry `Content-Type: image/webp`,
`Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, a sandboxing CSP, an `ETag`
(304 on `If-None-Match`) and `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`.
Revoking an approval clears the server cache immediately; browsers and CDNs may keep a copy for
up to a day. The proxy skips `/media/` so image responses carry no cookies or CSP nonce.

## 4. SEO controls

- `seo.title`, `seo.description`, `seo.canonical`, `seo.noindex` per page.
- Private surfaces, previews, the API and setup are disallowed in `robots.txt` and carry
  `X-Robots-Tag: noindex`.
- The sitemap lists static routes plus published markets, core services, resources and
  listings; drafts, planned services and private surfaces never appear.
- A location page is `noindex` while it has no observations, no editorial profile and no published
  `location_intro`; policies are `noindex` until reviewed.

Tests: `apps/web/src/app/seo.unit.test.ts`, `apps/web/src/components/public/site-content.unit.test.ts`.

## 5. Redirects (migrated URLs)

Admin → Content → Redirects. Each row: `fromPath` (must not be an API/private/internal path and
must not be a live page, static or published dynamic entity, so a redirect can never shadow a
page), `toPath` (app path or https URL), status `301`, `302` or `308`, active flag, note, hit
count. Loops and chains are refused.

**Bulk import**: paste or choose a `path,target,status` CSV, preview (dry run, nothing written),
then import the rows that validated. `source_url,target_url,decision` columns from
`docs/operations/site-inventory.csv` are accepted; only rows whose decision is `redirect` are
imported. Every row is reported with its outcome (`create`/`created`, `unchanged`, `skip`,
`error` + reason).

**Resolution** (`apps/web/src/proxy.ts`, `apps/web/src/lib/redirects/proxy-cache.ts`): the proxy
runs in the Node runtime before any route and must not query the database on every navigation.
It keeps an in-memory table of active redirects fetched from the app's own
`GET /api/v1/redirects/snapshot` (server-cached 30 s under the `redirect` prefix, so any write
invalidates it) and refreshes it in the background once it is 30 s old (`waitUntil`). A request
costs one Map lookup; only the first request after a cold start waits for the snapshot, bounded by
an 800 ms timeout, and falls through to the app if the fetch fails. Matches answer with the
**configured status** and an absolute `Location` (relative targets keep the visitor's query
string), `Cache-Control: public, max-age=300`, and report the hit to
`POST /api/v1/redirects/hits` after responding. GET/HEAD only; `/api` and `/_next` are never
redirected. The not-found boundary keeps a database lookup as the fallback (it can only answer
307/308) for the moments the snapshot is unavailable. The proxy reaches the app at
`INTERNAL_APP_URL` (default `http://127.0.0.1:$PORT`).

Tests: `apps/web/src/proxy.unit.test.ts` (status codes, query preservation, background refresh,
pass-through), `apps/web/src/server/content/redirects-import.int.test.ts` (guards, CSV import,
snapshot, hits), `apps/web/src/server/content/admin.int.test.ts` (fallback resolution).

## 6. Migration inventory

`docs/operations/site-inventory.csv` is the crawl template (one row per URL of the live site:
`source_url,status_code,title,content_type,decision,target_url,image_rights,owner,notes`, decision
`migrate|redirect|drop`). `pnpm --filter @simplexd/web reconcile:inventory [file] [--json]
[--check-live https://host]` reads it and reports, per row, whether the target is a live page in
the CMS/catalogue, whether a redirect is configured and matches, and (optionally) the HTTP status
a deployment answers with. Read-only; exit code 1 when any row is a gap. See
`docs/operations/cutover.md`.

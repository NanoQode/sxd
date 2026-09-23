# Cutover runbook: replacing the current simplexd.co website

The live simplexd.co site is never switched automatically: no deployment, script, job or
admin action changes DNS or replaces the current website. This runbook is executed by the
owner and the operations team, step by step, once the launch inputs are in place, and the
reconciliation below must be signed off before the DNS change.

## Preconditions

- Approved brand assets and copy loaded through Admin → Content; `brand.assets_approved`
  set to true in Admin → Settings.
- Content inventory of the current site completed (see below) and every approved URL either
  recreated at the same path or mapped in Admin → Content → Redirects (tested 301s).
- Paystack live keys activated in Admin → Integrations and a live-mode test payment of a
  small invoice verified and refunded.
- Termii sender ID approved and a test SMS delivered to a staff phone.
- SMTP domain authenticated (SPF, DKIM, DMARC) and a test email delivered.
- Google Workspace organiser connected; a test booking created and cancelled.
- Licensed map tiles configured; explorer renders on desktop and 360 px mobile.
- Backup taken and restore drill passed on the production database.
- Monitoring in place (health endpoint, certificate expiry, backup job, queue depth).

## Content inventory and migration

1. Crawl the current site into `docs/operations/site-inventory.csv` (template with three
   example rows to delete). One row per URL with the columns
   `source_url,status_code,title,content_type,decision,target_url,image_rights,owner,notes`;
   `decision` is one of:
   - `migrate`: the content is recreated in the CMS at `target_url` (same path when blank);
   - `redirect`: the URL is retired and `source_url` redirects to `target_url` (app path or
     https URL), status 301 unless `status_code` says 302/308;
   - `drop`: the URL is retired without a replacement and answers 404 after cutover.
2. Migrate only authorised content with image rights (`image_rights=yes`); keep metadata
   (titles, descriptions) in each page's SEO fields. Images go through Admin → Content →
   editor → "Insert or upload media" and need a second content editor's approval with alt
   text and a rights confirmation before they have a public URL (`docs/workflows/cms.md`).
3. Load the redirect rows: Admin → Content → Redirects → Bulk import, paste the inventory
   CSV as is (only `decision=redirect` rows are imported), preview, then import. Rows that
   would shadow a live page or point at another redirect are reported and skipped.
4. Reconcile: `pnpm --filter @simplexd/web reconcile:inventory` (add
   `--check-live https://<temporary-hostname>` once the new deployment is reachable) reports,
   per row, whether the target exists in the CMS/catalogue, whether the redirect is configured
   and matches, and what the deployment answers. It is read-only and exits 1 while any row is a
   gap; keep the `--json` output with the sign-off.
5. Marketing statistics, testimonials, partner badges and project claims are not carried
   over without owner evidence and publication rights.
6. Analytics identifiers are configured only when authorised and compatible with the
   consent banner.

## Cutover steps

1. Lower the DNS TTL for the apex/www records to 300 seconds at least 24 hours ahead.
2. Freeze content changes on the old site.
3. Take a fresh backup of the new platform (`ops/backup/backup.sh`).
4. Run the smoke checklist against the new deployment on a temporary hostname:
   home, explorer, a location page, a service page, consultation form (creates a lead),
   sign-in, portal home, admin overview, health endpoint, robots/sitemap.
5. Switch DNS to the new server (Caddy obtains the certificate automatically once the
   record resolves). Keep the old hosting running.
6. Re-run the smoke checklist on the real domain; check the redirect map with the
   inventory (`curl -I` on every mapped URL).
7. Watch logs, health and queue depth for the first hours; confirm webhooks (Paystack,
   Termii delivery reports, Google push) reach the new domain.

## Rollback

- DNS back to the old hosting (TTL 300 seconds keeps this fast). The new platform keeps
  running; leads and accounts created meanwhile are retained.
- If the platform itself must roll back a release, use `./deploy/deploy.sh rollback`.

## After cutover

- Raise DNS TTLs again after 48 hours.
- Decommission the old hosting only after the inventory reconciliation is signed off and
  a final export of the old site is archived.

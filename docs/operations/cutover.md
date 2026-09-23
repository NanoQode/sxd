# Cutover runbook: replacing the current simplexd.co website

The live site is never switched automatically. This runbook is executed by the owner
and the operations team once the launch inputs are in place.

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

1. Crawl the current site (`docs/operations/site-inventory.csv` template: URL, title,
   type, owner-approved?, image rights?, target path, redirect?).
2. Migrate only authorised content with image rights; keep metadata (titles, descriptions).
3. Record the reconciliation: for every crawled URL either a same-path page, a redirect, or
   an explicit "retired" decision.
4. Marketing statistics, testimonials, partner badges and project claims are not carried
   over without owner evidence and publication rights.
5. Analytics identifiers are configured only when authorised and compatible with the
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

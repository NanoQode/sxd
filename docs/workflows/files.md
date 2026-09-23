# Private file pipeline

Code: `apps/web/src/server/files/**` (services), `apps/web/src/app/api/v1/files/**` (routes),
`apps/worker/src/handlers/media.ts` (jobs), `packages/contracts/src/files.ts` (schemas, purpose
policies), adapters in `packages/integrations/src/{storage,scanner}` (see
`docs/providers/storage.md`).

## 1. Lifecycle

```
pending_upload ──finalize──▶ scanning ──scan clean──▶ clean ──files.derive──▶ clean (+derivatives)
      │                          │
      │ inspection failed        ├── infected     (object stays in quarantine, never served)
      ▼                          └── scan_failed  (retried ≤ 3×, then left quarantined with a reason)
   rejected
```

| Step     | Where                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent   | `POST /api/v1/files/upload-intents`            | Purpose-based authorisation, allow-list and size checks (`FILE_PURPOSE_POLICIES`), `file_objects` row in `quarantine`/`pending_upload` with a server-generated key (`buildStorageKey`) and a 7-day `retention_until`, signed PUT URL or multipart plan (parts with presigned URLs, 15-minute expiry). Rate limited 120/hour per user.                                                                                               |
| Upload   | client → storage                               | Bytes go straight to the quarantine bucket. In development the signed URL points at the local-dev route (below).                                                                                                                                                                                                                                                                                                                    |
| Finalize | `POST /api/v1/files/{id}/finalize`             | Owner only. Completes multipart uploads with part ETags, checks the object exists and matches the declared size, computes SHA-256 (verified against a declared checksum when supplied), sniffs the first 64 KiB (`inspectUploadedBytes`: magic numbers vs declared type, markup/script detection). Mismatch or active content → `rejected` (422 `file_rejected`). Otherwise `scanning` + outbox `file.uploaded`.                    |
| Scan     | worker `files.scan` / `media.scan_and_process` | Streams the quarantined object through the scanner. `clean` → copy to the private bucket, delete the quarantine copy, status `clean`, `files.derive` queued for images, `derivatives.video = 'original'` for video. `infected` → status `infected`, object stays quarantined. `error` → `scan_failed`, object stays quarantined, retry job after 1/2 minutes, at most 3 attempts, then `scanResult.exhausted = true` with a reason. |
| Derive   | worker `files.derive`                          | sharp: `web` (≤1600 px) and `thumb` (≤320 px) WebP variants, orientation applied, EXIF/GPS/ICC stripped, written to the derivatives bucket under `deriveVariantKey`. Originals are never modified. HEIC without codec support records `derivatives.error` and keeps the original.                                                                                                                                                   |
| Download | `GET /api/v1/files/{id}/download`              | Access check on every call, then a signed GET (default 300 s, max 900 s) and a 302 (or JSON with `Accept: application/json`). The `variant` query parameter (`thumb` or `web`) serves derivatives inline; originals are `attachment` unless inline-safe and requested inline. Every issuance is written to `file_download_log`.                                                                                                     |
| Purge    | worker `files.purge_expired`                   | Rows in `pending_upload`, `rejected`, `infected`, `scan_failed` past `retention_until` are marked `deleted` (existing maintenance job; statuses above match it).                                                                                                                                                                                                                                                                    |

Errors: quarantined states (`pending_upload`, `uploaded`, `scanning`, `scan_failed`) answer
423 `file_quarantined`; `infected` and `rejected` answer 422 `file_rejected`.

## 2. Purposes and who may upload

| Purpose         | Types                                | Ceiling                               | Who                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `org_document`  | images, PDF, docx/xlsx, csv, zip     | 100 MB (images 25 MB)                 | organisation members with `org.documents.upload`; staff with `projects.manage` on the entity's project/request                                                                                                                                               |
| `evidence`      | images, mp4/mov, PDF, docx/xlsx, csv | 2 GB video, 50 MB images, 100 MB docs | requires `entityType` project/site_visit/service_request; staff assigned (`site_visits.perform`, inspector/PM assignment rules), partners with an accepted/active assignment (`partner.evidence.upload`), the customer organisation (`org.documents.upload`) |
| `content_media` | images, mp4/mov, PDF                 | 512 MB video, 25 MB images            | staff with `content.media.manage`; no organisation                                                                                                                                                                                                           |
| `bank_receipt`  | images, PDF                          | 25 MB                                 | organisation members with `org.invoices.pay`                                                                                                                                                                                                                 |
| `identity`      | images, PDF                          | 25 MB                                 | any signed-in user, personal (no organisation); **sensitive**                                                                                                                                                                                                |

SVG, HTML, XML, JavaScript and executables are never allowed for any purpose, by declared type,
by extension and by content sniffing after upload. Uploads larger than 64 MB (or with
`multipart: true`) are planned as resumable multipart uploads.

## 3. Access policy (`apps/web/src/server/files/access.ts`)

Levels: `view` (metadata, thumb/web variants), `download` (original), `manage` (grants, approval).

Order of evaluation, all against rows read in the same transaction:

1. owner of the file;
2. staff: `files.read_all`; files with a sensitive purpose additionally require
   `files.sensitive.read` (the finance role does not have it);
3. explicit `file_access_grants` (user grants, or organisation grants for an organisation the
   user is **currently** a member of), not revoked and not expired; `view` grants do not allow
   the original;
4. organisation membership with `org.documents.view`, where memberships are **re-read from
   `member` on every call** — a revoked membership denies the next request even while the
   session still lists the organisation. Sensitive purposes never fall through to membership.

Files the caller cannot see answer `not_found` (ids are not enumerable); files they can see but
not use at the requested level answer `forbidden`.

Grants (`POST/GET /api/v1/files/{id}/grants`, `DELETE …/grants/{grantId}`): owner or staff with
`files.read_all`; sensitive files can only be granted to users; revocation keeps the row.

Listing (`GET /api/v1/files?entityType=&entityId=`): files attached to an entity filtered by the
same policy, newest first, cursor paginated.

## 4. Public approval

`POST /api/v1/files/{id}/public-approval` (staff with `evidence.approve` or
`content.media.manage`, never on their own upload) sets `is_public_approved`, which means the
file's **derivatives** may be referenced by public pages. Only clean images with a generated
`web` variant qualify; originals, documents, video and sensitive purposes are never public. An
approval requires alt text and a rights confirmation and is recorded in `media_assets`
(`approved_for_public`, `approved_by`) for the CMS media picker.

## 5. Development storage route

`apps/web/src/app/api/v1/dev/storage/[op]/route.ts` serves the local-dev adapter's signed URLs:
`PUT …/upload` and `PUT …/part` write to the quarantine directory (size bound by the signature),
`GET …/download` streams private/derivative objects with the signed content type and
disposition plus `X-Content-Type-Options: nosniff` and a sandboxing CSP. It answers 404 unless
`APP_ENV` is `development`/`test` and `STORAGE_PROVIDER=local-dev`, and refuses quarantine
downloads even with a valid signature. The adapter signs URLs under
`/api/v1/dev/storage/<op>`; serve that path with a rewrite to `/dev/storage/:op` (or move the
route file) in development.

## 6. Logging and audit

Audit rows: `file.upload_intent_created`, `file.finalized`, `file.rejected`, `file.scan_clean`,
`file.scan_infected`, `file.scan_failed`, `file.grant_created`, `file.grant_revoked`,
`file.public_approved`, `file.public_revoked`. Logs carry file ids, sizes, engines and reasons;
never signed URLs, storage keys in responses, or file contents.

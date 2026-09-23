# Object storage and malware scanning

Adapters: `packages/integrations/src/storage` (`S3StorageProvider`, `LocalDevStorageProvider`)
and `packages/integrations/src/scanner` (`ClamAvScanner`, `DevMalwareScanner`).

## 1. Buckets

| Bucket (env)                                                       | Purpose                                                                       | Access                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `S3_BUCKET_QUARANTINE`                                             | every direct upload lands here; unscanned, infected and `scan_failed` objects | write via presigned URLs; **never** downloadable (`createSignedDownloadUrl` refuses it) |
| `S3_BUCKET_PRIVATE`                                                | restricted originals after a `clean` verdict                                  | presigned GET only, after the app's access check (`file_access_grants`, memberships)    |
| `S3_BUCKET_DERIVATIVES` (optional, defaults to the private bucket) | compressed/redacted/thumbnail variants (`deriveVariantKey`)                   | presigned GET                                                                           |

All buckets are private (no public ACLs, Block Public Access on AWS, `mc anonymous set none`
on MinIO). Object keys are server-generated (`buildStorageKey`: `org/<org>/<purpose>/<uuid>.ext`),
limited to `[a-z0-9/_.-]`, never taken from the client.

## 2. Upload pipeline

1. Client asks for an upload (`file_objects` row `pending_upload`, declared MIME/size validated
   with `evaluateUpload` from `@simplexd/domain/evidence`; blocked SVG/HTML/script types and
   extensions rejected up front).
2. `createUploadIntent` → presigned **PUT** (single, ≤ ~64 MB suggested) or **multipart**
   (`planMultipartUpload`, presigned part URLs, resumable: the client retries individual parts
   and the app stores `multipart_upload_id`). The PUT signature binds `content-length`, so a URL
   issued for N bytes cannot upload another size. Content-Type is not signed (browser charset
   quirks), which is why step 4 re-detects it.
3. Client PUTs directly to the bucket; `completeMultipart` finalises with the part ETags. Abandoned
   multipart uploads are aborted by a lifecycle rule (below) and `abortMultipart`.
4. Worker: `headObject` (size), `sha256Hex` over the object (`verifyDeclaredChecksum` against the
   client-declared checksum — a mismatch fails the upload), `inspectUploadedBytes` on the first
   bytes (`file-type` magic numbers + markup/script sniffing; disguised SVG/HTML is rejected
   regardless of the declared type), then the scanner.
5. Verdicts: `clean` → `copyObject` quarantine→private, delete the quarantine copy, status
   `clean`, enqueue derivative generation; `infected` → status `infected`, object stays in
   quarantine, uploader notified; **`error` → status `scan_failed`, object stays in quarantine,
   retry job later** — a failed scanner never yields a downloadable file.
6. Capture time, uploader, checksum and optional GPS are stored as user-provided evidence
   metadata, separately from server receipt time.

## 3. Downloads

`createSignedDownloadUrl({ bucket, key, fileName, contentType, contentDisposition, expiresInSeconds })`
issues a short-lived presigned GET (default `SIGNED_URL_TTL_SECONDS=300`, max 7 days) with
`response-content-disposition` and `response-content-type` overrides:

- `inline` only for `image/*` (not SVG), `video/*` and `application/pdf`;
- everything else `attachment`;
- markup/XML/script types are always `attachment` with `application/octet-stream`.

Downloads are served from the bucket host, never the app origin; the app's CSP does not include
the bucket in `script-src`. Access is checked on every URL issuance, so a revoked membership
blocks fresh URLs immediately and an issued URL dies at expiry (acceptance scenario 12).

## 4. S3 / MinIO configuration

```
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://minio.internal:9000      # omit for AWS
S3_REGION=eu-west-1
S3_FORCE_PATH_STYLE=true                     # MinIO and most self-hosted stores
S3_ACCESS_KEY_ID=… / S3_SECRET_ACCESS_KEY=…  # or an IAM role (leave empty)
S3_BUCKET_PRIVATE=simplexd-private
S3_BUCKET_QUARANTINE=simplexd-quarantine
S3_BUCKET_DERIVATIVES=                       # optional
SIGNED_URL_TTL_SECONDS=300
```

The client is created with `requestChecksumCalculation: WHEN_REQUIRED` so presigned PUTs work
from browsers and MinIO.

### CORS (quarantine bucket only — browsers PUT directly)

```json
[
  {
    "AllowedOrigins": ["https://simplexd.co", "https://staging.simplexd.co"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: ETag` is required so the browser can read part ETags for `completeMultipart`.
The private/derivatives buckets need no CORS (downloads are navigations/`<img>`/`<video>`), unless
the app fetches objects with XHR, in which case allow `GET` from the app origins only.

### Lifecycle rules

| Bucket      | Rule                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quarantine  | abort incomplete multipart uploads after 2 days; expire objects after 30 days (infected/failed objects are kept only as long as the incident review needs them)              |
| private     | no expiry (retention is driven by `file_objects.retention_until` and the deletion job); enable versioning if the platform supports it, so accidental deletes are recoverable |
| derivatives | regenerable; expire after 180 days of no access or on original deletion                                                                                                      |

Enable server-side encryption (SSE-S3/KMS) and bucket-level access logging.

## 5. ClamAV profile

```
MALWARE_SCANNER=clamav
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
CLAMAV_TIMEOUT_MS=60000     # optional
CLAMAV_MAX_BYTES=104857600  # optional; keep ≤ clamd StreamMaxLength
```

Run `clamav/clamav:stable` (or the `clamav` Compose profile) with `freshclam` updates enabled and
`clamd.conf`: `TCPSocket 3310`, `TCPAddr 0.0.0.0` (internal network only), `StreamMaxLength 100M`,
`MaxFileSize 100M`, `MaxScanSize 500M`. The adapter uses `zINSTREAM` with 64 KiB length-prefixed
chunks, `zPING`/`zVERSION` for the admin health check, and returns an `error` verdict on
timeout, refusal, size limits or unexpected replies. Files larger than `CLAMAV_MAX_BYTES` are
not scanned and remain quarantined; raise the limit deliberately rather than skipping the scan.
The development scanner (`MALWARE_SCANNER=dev`) flags the EICAR test string and treats file
names containing `.scan-error.` as a scanner failure; production refuses it.

## 6. Retention and deletion

- `file_objects.retention_until` and organisation policies drive deletion jobs; a deletion request
  may still require restricted retention of accounting/legal evidence (documented outcome, not
  silent refusal).
- Deleting a file removes the private object, its derivatives and the quarantine copy, then marks
  the row `deleted`; audit rows never contain object contents.
- Public listings only ever reference `derivatives` objects that were explicitly approved and
  redacted (`is_public_approved`).

## 7. Backups and restore reconciliation

Database backups contain object **metadata** (`file_objects.storage_key`, checksum, size, status),
not the bytes; buckets are backed up by the storage platform (versioning + replication). After a
restore:

1. Restore the database, then run the reconciliation job: for every `file_objects` row that is
   `clean`/`scanning`, `headObject` the expected bucket/key and compare `sizeBytes` and (sampled)
   `sha256Hex` with the recorded checksum.
2. Missing objects → status `deleted` with an incident note; objects present in storage but
   absent from the database → quarantine (they cannot be served without a row and a grant).
3. Objects `uploaded`/`scanning` at backup time are rescanned from quarantine before promotion.

`LocalDevStorageProvider` (development/test only) stores everything under `./uploads-dev` and
serves signed URLs through `/api/v1/dev/storage/{upload|part|download}` with HMAC tokens; the
route verifies with `verifySignedRequest`, enforces the signed size and sends
`X-Content-Type-Options: nosniff` plus the signed disposition.

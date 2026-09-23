# Integrations: configuration versions, secrets and health

Server module `apps/web/src/server/integrations/` (catalogue, checks, service, re-wrap); routes under `apps/web/src/app/api/v1/admin/integrations/`; contracts in `packages/contracts/src/integrations.ts`; OpenAPI in `apps/web/src/lib/api/registry/integrations.ts`; worker jobs in `apps/worker/src/handlers/integrations.ts`; console at `/admin/integrations`. Owner-facing setup index: [docs/providers/README.md](../providers/README.md).

Every service function takes an `AdminContext`, authorises with `@simplexd/domain/authz` (`integrations.read` / `manage` / `test` / `secrets.rotate` / `payment_credentials.manage`; the write permissions require a verified authenticator and are refused during impersonation), runs inside `transact()` so row-level security applies, writes an audit event with redacted before/after and an `integration_logs` row in the same transaction.

## Version lifecycle

```
PUT /{provider}            POST /{provider}/test              POST /{provider}/activate
  save → v(n+1)  ─────────▶  check recorded on v(n+1) ─────────▶  is_active flips atomically
  configured_unverified      lastCheckOk / lastCheckMessage         connected (passed test)
  is_active = false          status unchanged unless active         configured_unverified (forced, reason)
                                                                    previous active → disconnected
```

- `integration_configs` is append-only per `(provider, environment)`: every save is a new `version`; a partial unique index guarantees at most one `is_active` row per provider/environment.
- `secret_ids` maps field name → `secret_references.id`. Saving carries unchanged ids forward and inserts new rows only for the fields that were entered; `clearSecrets` drops a field from the new version. `loadIntegrationConfig` (`@simplexd/integrations/config`) reads the active row and decrypts through the same map, so the runtime never needs to know about versions.
- Activation guards: a passed test on that exact version (or `force` + reason, audited, shown as “Active, not verified”); required secrets present; production refuses the provider's development adapter; Paystack key prefixes must match the environment (`detectKeyEnvironment`). Every Paystack save, rotation and activation applies the prefix guard even for the development adapter so a live key can never sit in the test environment.
- `POST /{provider}/disable` sets `disabled` / `is_active=false` with a reason. Re-activation goes through the normal activate path.

## Checks

`runProviderCheck` (`checks.ts`) builds the real adapter from the saved settings and decrypted secrets and runs its own verification (`testConnection`, `verifyConnection` + `checkDnsRecords`, `headObject`, `ping`, `resolveMapConfig`/`assertLicensedProvider`). Results are labelled `development` when the adapter is the labelled dev adapter, and every message and detail object is passed through `scrubSecrets` (all decrypted values are replaced by `[redacted]`) before it is stored or returned. Checks run under a timeout so a hung provider cannot pin an admin request. Google Workspace cannot be exercised without an organiser grant, so its check validates the OAuth client and reports the `calendar_connections` state separately; the grant itself is completed at `/api/v1/calendar/connect`.

## Secrets

- Envelope encryption (`@simplexd/integrations/secrets`): per-secret DEK, AES-256-GCM, DEK wrapped by the master key with the key id as AAD. Database backups therefore hold ciphertext only.
- API responses expose `{ set, fingerprint (8 hex chars), masked, updatedAt, masterKeyId }` per field; `service.int.test.ts` serialises every response and asserts no plaintext, ciphertext or wrapped key appears.
- Rotation (`POST /{provider}/rotate-secret`): new `secret_references` row (`version+1`, `rotatedAt`), old row `retiredAt` + `rotatedAt`, new configuration version keeping the other secrets, `credentialRotatedAt` set. If the rotated version was active the new version is checked immediately and activated on success; on failure the old version is marked `expired` with a scrubbed message because its secret is gone. The old value is never returned.
- Master-key rotation: `POST /rewrap` counts non-retired rows whose `master_key_id` differs from the current key, enqueues `integrations.rewrap_secrets` (deduped per key id per minute) and audits the request. The worker re-wraps in memory (`rewrapSecret`) and logs counts; rows the keyring cannot open are reported, not skipped.

## Health

`integrations.health_check` runs hourly from the worker scheduler over every active configuration: success → `connected`, failure → `degraded`, provider-rejected credential → `expired`. Each run writes `integration_logs` (`health.check`) and, only on a transition into a failing state, appends an `integration.degraded` outbox event carrying provider, environment, version, status and the scrubbed message so administrators are notified once per incident. (Routing that event to a notification job is done in the worker's outbox map by the notifications owner.)

## Tests

`apps/web/src/server/integrations/service.int.test.ts` covers: save → `configured_unverified` with encrypted rows and fingerprints; carried-over secret ids; live-key-in-test refusal; MFA and payment-credential denials; development-adapter tests for all seven providers; activate refused without a test, forced activation with reason, production refusal of dev adapters; disable with audited reason; rotation retiring the old row, verifying and activating; re-wrap under a second keyring (`keyringFromEnv` with an explicit env object) with `loadIntegrationConfig` still decrypting; and a JSON scan of every response, log and audit row for secret material.

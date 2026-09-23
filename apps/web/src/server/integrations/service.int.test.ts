import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import { loadIntegrationConfig } from '@simplexd/integrations/config';
import {
  decryptSecret,
  fingerprintSecret,
  keyringFromEnv,
  type Keyring,
} from '@simplexd/integrations/secrets';
import type { AdminContext } from '../admin/context';
import { contextFor, identityFor, insertStaffUser } from '../admin/test-support';
import { rewrapPendingSecrets } from './rewrap';
import {
  activateIntegration,
  disableIntegration,
  getIntegration,
  listIntegrationLogs,
  listIntegrations,
  requestRewrap,
  rotateIntegrationSecret,
  saveIntegration,
  testIntegration,
} from './service';

/**
 * Admin → Integrations: save ≠ test ≠ activate, envelope-encrypted secrets,
 * rotation, master-key re-wrap, MFA and production guards. Every response
 * produced during the run is serialised and scanned for secret material
 * (acceptance scenario 8).
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const keyringA: Keyring = keyringFromEnv({
  SECRETS_MASTER_KEY: KEY_A,
  SECRETS_MASTER_KEY_ID: 'key-a',
});
const keyringB: Keyring = keyringFromEnv({
  SECRETS_MASTER_KEY: KEY_B,
  SECRETS_MASTER_KEY_ID: 'key-b',
  SECRETS_PREVIOUS_MASTER_KEY: KEY_A,
  SECRETS_PREVIOUS_MASTER_KEY_ID: 'key-a',
});

const SECRET_KEY = 'sk_test_fixture_a1';
const PUBLIC_KEY = 'pk_test_fixture_b2';
const ROTATED_KEY = 'sk_test_fixture_c3';
const TERMII_KEY = 'TLxyzTermiiApiKeySample1234567890';
const ALL_SECRETS = [SECRET_KEY, PUBLIC_KEY, ROTATED_KEY, TERMII_KEY];

const users = {
  admin: { id: 'user_int_admin', name: 'Ada Admin', email: 'int-admin@example.test' },
  noMfa: { id: 'user_int_nomfa', name: 'Nora NoMfa', email: 'int-nomfa@example.test' },
  ops: { id: 'user_int_ops', name: 'Olu Ops', email: 'int-ops@example.test' },
};

let dbs: TestDatabases;
let admin: AdminContext;
let adminNoMfa: AdminContext;
let ops: AdminContext;
const responses: unknown[] = [];
const opts = { keyring: keyringA, appEnv: 'test', nodeEnv: 'test', appUrl: 'http://localhost:3000' };

function record<T>(value: T): T {
  responses.push(value);
  return value;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await insertStaffUser(dbs.owner, users.admin, ['super_admin']);
  await insertStaffUser(dbs.owner, users.noMfa, ['super_admin']);
  await insertStaffUser(dbs.owner, users.ops, ['operations_manager']);
  admin = contextFor(dbs.app, identityFor(users.admin, ['super_admin']));
  adminNoMfa = contextFor(dbs.app, identityFor(users.noMfa, ['super_admin'], { mfaVerified: false }));
  ops = contextFor(dbs.app, identityFor(users.ops, ['operations_manager']));
});

afterAll(async () => {
  await dbs.close();
});

describe('save (new version, never active)', () => {
  it('stores settings and envelope-encrypted secrets as configured_unverified', async () => {
    const dto = record(
      await saveIntegration(
        admin,
        'paystack',
        {
          environment: 'test',
          adapter: 'dev',
          settings: { currency: 'NGN', enabledPurposes: ['invoice'], channels: ['card'] },
          secrets: { secretKey: SECRET_KEY, publicKey: PUBLIC_KEY },
          clearSecrets: [],
          reason: 'initial setup',
        },
        opts,
      ),
    );
    expect(dto.version).toBe(1);
    expect(dto.status).toBe('configured_unverified');
    expect(dto.isActive).toBe(false);
    expect(dto.developmentAdapter).toBe(true);
    expect(dto.secrets.secretKey).toMatchObject({ set: true, fingerprint: fingerprintSecret(SECRET_KEY).slice(0, 8) });
    expect(dto.secrets.webhookSecret).toMatchObject({ set: false, fingerprint: null });

    const rows = await dbs.owner
      .select()
      .from(schema.secretReferences)
      .where(eq(schema.secretReferences.provider, 'paystack'));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.masterKeyId).toBe('key-a');
      expect(row.ciphertext.toString('utf8')).not.toContain('sk_test_');
      expect(row.ciphertext.toString('utf8')).not.toContain('pk_test_');
      expect(row.retiredAt).toBeNull();
    }
    const secretRow = rows.find((r) => r.fieldName === 'secretKey')!;
    expect(secretRow.fingerprint).toBe(fingerprintSecret(SECRET_KEY));
    expect(decryptSecret(secretRow, keyringA)).toBe(SECRET_KEY);

    const audits = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'integration.saved'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.after)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(audits[0]!.after)).toContain('secretsChanged');
  });

  it('refuses a live key in the test environment (test and live never mixed)', async () => {
    await expect(
      saveIntegration(
        admin,
        'paystack',
        {
          environment: 'test',
          adapter: 'paystack',
          settings: {},
          secrets: { secretKey: 'sk_live_fixture_d4' },
          clearSecrets: [],
        },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('carries unchanged secrets over by id and only re-encrypts what was provided', async () => {
    const before = await dbs.owner
      .select()
      .from(schema.integrationConfigs)
      .where(eq(schema.integrationConfigs.version, 1));
    const v2 = record(
      await saveIntegration(
        admin,
        'paystack',
        {
          environment: 'test',
          adapter: 'dev',
          settings: { currency: 'NGN' },
          secrets: {},
          clearSecrets: [],
        },
        opts,
      ),
    );
    expect(v2.version).toBe(2);
    const [row] = await dbs.owner
      .select()
      .from(schema.integrationConfigs)
      .where(eq(schema.integrationConfigs.id, v2.id));
    expect(row!.secretIds).toEqual(before[0]!.secretIds);
  });

  it('denies writes without a verified authenticator (mfa_required)', async () => {
    let error: unknown;
    try {
      await saveIntegration(
        adminNoMfa,
        'termii',
        { environment: 'test', adapter: 'dev', settings: { senderId: 'SimplexD' }, secrets: {}, clearSecrets: [] },
        opts,
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AuthorizationError);
    expect((error as AuthorizationError).decision).toMatchObject({ code: 'mfa_required' });
  });

  it('denies Paystack secret changes without the payment-credentials permission', async () => {
    await expect(
      saveIntegration(
        ops,
        'paystack',
        { environment: 'test', adapter: 'dev', settings: {}, secrets: { publicKey: PUBLIC_KEY }, clearSecrets: [] },
        opts,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('test connection (real adapter result recorded on the version)', () => {
  it('records a labelled development result and an integration log entry', async () => {
    const result = record(await testIntegration(admin, 'paystack', { environment: 'test', version: 1 }, opts));
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('development');
    expect(result.message).toMatch(/development adapter/i);
    expect(result.config.lastCheckOk).toBe(true);
    expect(result.config.status).toBe('configured_unverified');
    expect(result.config.remedialAction).toMatch(/activate/i);
    const logs = record(await listIntegrationLogs(admin, 'paystack', { environment: 'test' }));
    expect(logs.some((l) => l.event === 'connection.test')).toBe(true);
  });

  it('runs the Termii, scanner, storage, mail, calendar and maps development checks', async () => {
    const saves: Array<[Parameters<typeof saveIntegration>[1], Record<string, unknown>, Record<string, string>]> = [
      ['termii', { senderId: 'SimplexD', baseUrl: 'https://v3.api.termii.com' }, { apiKey: TERMII_KEY }],
      ['scanner', { host: '127.0.0.1', port: 3310 }, {}],
      ['storage', { devRoot: './uploads-dev-test' }, {}],
      ['smtp', { host: 'localhost', port: 1025, security: 'starttls', fromName: 'SimplexD', fromEmail: 'no-reply@example.test' }, {}],
      ['google_workspace', { clientId: 'abc.apps.googleusercontent.com' }, { clientSecret: 'GOCSPX-sample-secret-value-1' }],
      ['maps', { styleUrlLight: 'https://demotiles.maplibre.org/style.json' }, {}],
    ];
    for (const [provider, settings, secrets] of saves) {
      const adapter = provider === 'storage' ? 'local-dev' : 'dev';
      record(await saveIntegration(admin, provider, { environment: 'test', adapter, settings, secrets, clearSecrets: [] }, opts));
      const result = record(await testIntegration(admin, provider, { environment: 'test' }, opts));
      expect(result.mode, provider).toBe('development');
      expect(result.ok, `${provider}: ${result.message}`).toBe(true);
      expect(result.config.lastCheckAt).not.toBeNull();
    }
  });

  it('is available to staff with integrations.test only', async () => {
    const result = record(await testIntegration(ops, 'termii', { environment: 'test' }, opts));
    expect(result.ok).toBe(true);
  });
});

describe('activate (requires a passed test on that version)', () => {
  it('refuses an untested version and accepts the tested one atomically', async () => {
    await expect(activateIntegration(admin, 'paystack', { environment: 'test', version: 2 }, opts)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const active = record(await activateIntegration(admin, 'paystack', { environment: 'test', version: 1 }, opts));
    expect(active.isActive).toBe(true);
    expect(active.status).toBe('connected');
    expect(active.activatedBy).toBe(users.admin.id);

    const loaded = await loadIntegrationConfig(dbs.app, 'paystack', { environment: 'test', keyring: keyringA });
    expect(loaded?.version).toBe(1);
    expect(loaded?.secrets.secretKey).toBe(SECRET_KEY);
  });

  it('force-activates with a reason as "active, not verified" and deactivates the previous version', async () => {
    await expect(
      activateIntegration(admin, 'paystack', { environment: 'test', version: 2, force: true }, opts),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const forced = record(
      await activateIntegration(admin, 'paystack', { environment: 'test', version: 2, force: true, reason: 'hotfix' }, opts),
    );
    expect(forced.isActive).toBe(true);
    expect(forced.status).toBe('configured_unverified');
    const rows = await dbs.owner
      .select()
      .from(schema.integrationConfigs)
      .where(eq(schema.integrationConfigs.provider, 'paystack'));
    expect(rows.filter((r) => r.isActive)).toHaveLength(1);
    expect(rows.find((r) => r.version === 1)?.status).toBe('disconnected');
    // A passing test on the active version restores "connected".
    const rerun = record(await testIntegration(admin, 'paystack', { environment: 'test', version: 2 }, opts));
    expect(rerun.config.status).toBe('connected');
  });

  it('production refuses development adapters', async () => {
    await expect(
      activateIntegration(admin, 'termii', { environment: 'test' }, { ...opts, appEnv: 'production' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const detail = record(await getIntegration(admin, 'termii', opts));
    expect(detail.environments.find((e) => e.environment === 'test')?.active).toBeNull();
  });

  it('disable turns the active version off with an audited reason', async () => {
    const tested = await testIntegration(admin, 'scanner', { environment: 'test' }, opts);
    expect(tested.ok).toBe(true);
    record(await activateIntegration(admin, 'scanner', { environment: 'test' }, opts));
    const disabled = record(await disableIntegration(admin, 'scanner', { environment: 'test', reason: 'maintenance window' }, opts));
    expect(disabled.status).toBe('disabled');
    expect(disabled.isActive).toBe(false);
    const audits = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'integration.disabled'));
    expect(audits[0]?.reason).toBe('maintenance window');
  });
});

describe('secret rotation', () => {
  it('retires the old secret, bumps the version keeping other secrets, verifies and activates', async () => {
    const before = await dbs.owner
      .select()
      .from(schema.integrationConfigs)
      .where(eq(schema.integrationConfigs.isActive, true));
    const activePaystack = before.find((r) => r.provider === 'paystack')!;
    const oldSecretId = activePaystack.secretIds.secretKey!;

    const result = record(
      await rotateIntegrationSecret(
        admin,
        'paystack',
        { environment: 'test', field: 'secretKey', value: ROTATED_KEY, reason: 'quarterly rotation' },
        opts,
      ),
    );
    expect(result.retiredSecretId).toBe(oldSecretId);
    expect(result.check?.ok).toBe(true);
    expect(result.activated).toBe(true);
    expect(result.config.isActive).toBe(true);
    expect(result.config.version).toBe(activePaystack.version + 1);
    expect(result.config.secrets.secretKey.fingerprint).toBe(fingerprintSecret(ROTATED_KEY).slice(0, 8));
    expect(result.config.secrets.publicKey.fingerprint).toBe(fingerprintSecret(PUBLIC_KEY).slice(0, 8));
    expect(result.config.credentialRotatedAt).not.toBeNull();

    const [old] = await dbs.owner
      .select()
      .from(schema.secretReferences)
      .where(eq(schema.secretReferences.id, oldSecretId));
    expect(old!.retiredAt).not.toBeNull();
    const loaded = await loadIntegrationConfig(dbs.app, 'paystack', { environment: 'test', keyring: keyringA });
    expect(loaded?.secrets.secretKey).toBe(ROTATED_KEY);
    expect(loaded?.secrets.publicKey).toBe(PUBLIC_KEY);

    const logs = record(await listIntegrationLogs(admin, 'paystack', { environment: 'test', limit: 100 }));
    expect(logs.some((l) => l.event === 'secret.rotated')).toBe(true);
  });

  it('rejects a rotated Paystack key from the wrong environment', async () => {
    await expect(
      rotateIntegrationSecret(
        admin,
        'paystack',
        { environment: 'test', field: 'secretKey', value: 'sk_live_fixture_d4', reason: 'oops' },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('requires integrations.secrets.rotate', async () => {
    await expect(
      rotateIntegrationSecret(ops, 'termii', { environment: 'test', field: 'apiKey', value: 'anotherTermiiKey123456', reason: 'x' }, opts),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('master-key re-wrap', () => {
  it('reports pending secrets, enqueues the job and re-wraps under the new key id', async () => {
    const request = record(await requestRewrap(admin, { ...opts, keyring: keyringB }));
    expect(request.masterKeyId).toBe('key-b');
    expect(request.pending).toBeGreaterThan(0);
    expect(request.total).toBeGreaterThanOrEqual(request.pending);
    const [job] = await dbs.owner.select().from(schema.jobs).where(eq(schema.jobs.id, request.jobId));
    expect(job?.type).toBe('integrations.rewrap_secrets');

    const report = await rewrapPendingSecrets(dbs.app, keyringB);
    expect(report.rewrapped).toBe(request.pending);
    expect(report.failed).toEqual([]);

    const rows = await dbs.owner.select().from(schema.secretReferences);
    for (const row of rows.filter((r) => !r.retiredAt)) {
      expect(row.masterKeyId).toBe('key-b');
      expect(() => decryptSecret(row, keyringB)).not.toThrow();
    }
    // Retired rows are left alone (still wrapped by key-a).
    expect(rows.filter((r) => r.retiredAt).every((r) => r.masterKeyId === 'key-a')).toBe(true);
    const loaded = await loadIntegrationConfig(dbs.app, 'paystack', { environment: 'test', keyring: keyringB });
    expect(loaded?.secrets.secretKey).toBe(ROTATED_KEY);

    const again = record(await requestRewrap(admin, { ...opts, keyring: keyringB, now: () => new Date(Date.now() + 120_000) }));
    expect(again.pending).toBe(0);
  });
});

describe('responses never contain secret material', () => {
  it('overview and detail carry only masked presence', async () => {
    const overview = record(await listIntegrations(admin, { ...opts, keyring: keyringB }));
    expect(overview.items.map((i) => i.provider)).toContain('paystack');
    const paystack = overview.items.find((i) => i.provider === 'paystack')!;
    const test = paystack.environments.find((e) => e.environment === 'test')!;
    expect(test.status).toBe('connected');
    expect(test.active?.secrets.secretKey.masked).toMatch(/fingerprint/);
    expect(overview.secretsNeedingRewrap).toBe(0);
    record(await getIntegration(admin, 'paystack', opts));
    record(await getIntegration(ops, 'smtp', opts));
  });

  it('serialised JSON of every response is free of plaintext, ciphertext and wrapped keys', () => {
    expect(responses.length).toBeGreaterThan(10);
    const secretRowsPromise = dbs.owner.select().from(schema.secretReferences);
    return secretRowsPromise.then((rows) => {
      const forbidden = [
        ...ALL_SECRETS,
        'GOCSPX-sample-secret-value-1',
        ...rows.map((r) => r.ciphertext.toString('base64')),
        ...rows.map((r) => r.wrappedDek.toString('base64')),
        ...rows.map((r) => r.ciphertext.toString('hex')),
      ];
      for (const response of responses) {
        const text = JSON.stringify(response);
        for (const value of forbidden) expect(text).not.toContain(value);
        expect(text).not.toMatch(/"(ciphertext|wrappedDek|dekIv|dekTag)"/);
      }
    });
  });

  it('integration logs and audit rows are free of secret values', async () => {
    const logs = await dbs.owner.select().from(schema.integrationLogs);
    const audits = await dbs.owner.select().from(schema.auditEvents);
    const text = JSON.stringify({ logs, audits });
    for (const value of ALL_SECRETS) expect(text).not.toContain(value);
  });

  it('unknown providers are a 404, not a crash', async () => {
    await expect(getIntegration(admin, 'stripe' as never, opts)).rejects.toBeInstanceOf(ApiError);
  });
});

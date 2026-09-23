import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, systemContext, withActor } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { opsAlertRoles, resolveOpsAlert } from './ops-alerts';

/**
 * `ops.alert` → staff with the roles named on the event, via the generic
 * activity_update template. The test database is shared, so assertions look
 * for this run's fixtures among the recipients rather than exact lists.
 */

const dbs: TestDatabases = connectTestDatabases();
const run = uniqueSuffix();
const finance = `user_ops_fin_${run}`;
const admin = `user_ops_admin_${run}`;
const editor = `user_ops_editor_${run}`;
const revoked = `user_ops_revoked_${run}`;
const env = { appUrl: 'https://app.example.test' } as Parameters<typeof resolveOpsAlert>[0]['env'];

beforeAll(async () => {
  await dbs.owner.insert(schema.user).values(
    [finance, admin, editor, revoked].map((id) => ({ id, name: id, email: `${id}@example.test` })),
  );
  await dbs.owner.insert(schema.staffRoles).values([
    { userId: finance, role: 'finance' },
    { userId: admin, role: 'super_admin' },
    { userId: editor, role: 'data_editor' },
    { userId: revoked, role: 'finance', revokedAt: new Date() },
  ]);
});

afterAll(async () => {
  await dbs.close();
});

const resolve = (payload: Record<string, unknown>) =>
  withActor(dbs.app, systemContext(), (tx) =>
    resolveOpsAlert({
      tx,
      event: { aggregateId: `webhooks.payments@2026-09-23T10:00:00.000Z`, correlationId: 'c-1' },
      payload,
      env,
      scope: 'outbox:42',
    }),
  );

describe('ops.alert resolver', () => {
  it('notifies active staff holding the named roles with the activity_update template', async () => {
    const [request] = await resolve({
      key: 'webhooks.payments',
      severity: 'critical',
      title: 'Payment webhooks are failing',
      message: '7 payment webhooks failed in the last hour.',
      linkPath: '/admin/integrations/paystack',
      roles: ['finance'],
    });
    const userIds = request!.recipients.map((r) => r.userId);
    expect(userIds).toContain(finance);
    expect(userIds).not.toContain(admin);
    expect(userIds).not.toContain(editor);
    expect(userIds).not.toContain(revoked);
    expect(request).toMatchObject({
      templateKey: 'activity_update',
      category: 'transactional',
      channels: ['email', 'in_app'],
      variables: {
        title: 'Critical: Payment webhooks are failing',
        message: '7 payment webhooks failed in the last hour.',
        linkUrl: 'https://app.example.test/admin/integrations/paystack',
      },
      dedupeScope: 'outbox:42',
      inApp: { linkPath: '/admin/integrations/paystack' },
      relatedEntity: { type: 'ops_alert', id: null },
      organizationId: null,
      correlationId: 'c-1',
    });
  });

  it('falls back to super admins and the operations page for unknown roles or foreign links', async () => {
    const [request] = await resolve({
      title: 'Queue lag',
      message: 'm',
      roles: ['customer', 42],
      linkPath: 'https://evil.example/phish',
    });
    const userIds = request!.recipients.map((r) => r.userId);
    expect(userIds).toContain(admin);
    expect(userIds).not.toContain(finance);
    expect(request!.inApp).toEqual({ linkPath: '/admin/operations' });
    expect(request!.variables).toMatchObject({ title: 'Warning: Queue lag' });
  });

  it('keeps only valid staff roles', () => {
    expect(opsAlertRoles(['finance', 'finance', 'nope', 'super_admin'])).toEqual([
      'finance',
      'super_admin',
    ]);
    expect(opsAlertRoles(undefined)).toEqual(['super_admin']);
  });
});

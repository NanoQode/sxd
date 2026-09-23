import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@simplexd/contracts';
import {
  appendOutbox,
  claimJobs,
  claimOutboxBatch,
  enqueueJob,
  failJob,
  OUTBOX_MAX_ATTEMPTS,
  schema,
} from '@simplexd/db';
import { connectTestDatabases, resetDatabase, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  listJobs,
  listStuckOutbox,
  operationsAccess,
  queueSummary,
  requeueOutboxEvent,
  retryJob,
} from './jobs';

/**
 * Admin → Operations: dead-letter review and retry, stuck outbox requeue.
 * Payloads carry personal data and must never appear in a response; retry
 * and requeue are MFA-gated (platform.settings.manage) and audited.
 */

const users = {
  admin: { id: 'user_ops_admin', name: 'Ada Admin', email: 'ops-admin@example.test' },
  noMfa: { id: 'user_ops_nomfa', name: 'Nora NoMfa', email: 'ops-nomfa@example.test' },
  ops: { id: 'user_ops_manager', name: 'Olu Ops', email: 'ops-manager@example.test' },
  customer: { id: 'user_ops_customer', name: 'Chi Customer', email: 'ops-cust@example.test' },
};

const PERSONAL_EMAIL = 'private.person@example.test';
const PERSONAL_PHONE = '+2348012345678';

let dbs: TestDatabases;
let admin: AdminContext;
let adminNoMfa: AdminContext;
let ops: AdminContext;
let customer: AdminContext;

/** Enqueues a job with personal data in its payload and drives it to `dead` the way the worker does. */
async function makeDeadJob(type: string, error: unknown, queue = 'notifications'): Promise<string> {
  const { id } = await enqueueJob(dbs.owner, {
    type,
    queue,
    payload: { email: PERSONAL_EMAIL, phone: PERSONAL_PHONE, templateKey: 'welcome' },
    maxAttempts: 1,
    correlationId: `corr-${type}`,
  });
  const claimed = await dbs.owner.transaction((tx) =>
    claimJobs(tx, { workerId: 'test-worker', queues: [queue], limit: 10 }),
  );
  const job = claimed.find((c) => c.id === id);
  expect(job).toBeDefined();
  expect(await failJob(dbs.owner, job!, error)).toBe('dead');
  return id;
}

async function jobRow(id: string) {
  const [row] = await dbs.owner.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return row!;
}

async function auditRows(action: string, entityId: string) {
  return dbs.owner
    .select()
    .from(schema.auditEvents)
    .where(
      and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.entityId, entityId)),
    );
}

async function denial(promise: Promise<unknown>): Promise<AuthorizationError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AuthorizationError);
  return error as AuthorizationError;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await resetDatabase(dbs.owner);
  await insertStaffUser(dbs.owner, users.admin, ['super_admin']);
  await insertStaffUser(dbs.owner, users.noMfa, ['super_admin']);
  await insertStaffUser(dbs.owner, users.ops, ['operations_manager']);
  await insertStaffUser(dbs.owner, users.customer, []);
  admin = contextFor(dbs.app, identityFor(users.admin, ['super_admin']));
  adminNoMfa = contextFor(
    dbs.app,
    identityFor(users.noMfa, ['super_admin'], { mfaVerified: false }),
  );
  ops = contextFor(dbs.app, identityFor(users.ops, ['operations_manager']));
  customer = contextFor(dbs.app, identityFor(users.customer, []));
});

afterAll(async () => {
  await dbs.close();
});

describe('dead jobs', () => {
  let deadId: string;

  it('lists a dead job with sanitized error and payload keys only, never the payload', async () => {
    deadId = await makeDeadJob(
      'notification.send',
      new Error('provider refused: Bearer abc.def-123 token=supersecret'),
    );
    const page = await listJobs(admin, { status: 'dead', limit: 25 });
    const item = page.items.find((i) => i.id === deadId);
    expect(item).toMatchObject({
      id: deadId,
      queue: 'notifications',
      type: 'notification.send',
      status: 'dead',
      attempts: 1,
      maxAttempts: 1,
      correlationId: 'corr-notification.send',
      organizationId: null,
      payloadKeys: ['email', 'phone', 'templateKey'],
    });
    expect(item).not.toHaveProperty('payload');
    expect(item!.lastError).toContain('Bearer [redacted]');
    expect(item!.lastError).toContain('token=[redacted]');
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(PERSONAL_EMAIL);
    expect(serialized).not.toContain(PERSONAL_PHONE);
    expect(serialized).not.toContain('supersecret');
  });

  it('reports queue depth including dead jobs', async () => {
    const summary = await queueSummary(admin);
    expect(summary).toMatchObject({
      dead: 1,
      outboxStuck: 0,
      outboxStuckThreshold: OUTBOX_MAX_ATTEMPTS,
    });
  });

  it('lets audit.read-only staff list but not retry', async () => {
    expect(operationsAccess(ops)).toMatchObject({ canRead: true, canManage: false });
    const page = await listJobs(ops, { status: 'dead' });
    expect(page.items.map((i) => i.id)).toContain(deadId);
    const error = await denial(retryJob(ops, deadId, 'Provider fixed'));
    expect(error.decision.code).toBe('no_permission');
    expect((await jobRow(deadId)).status).toBe('dead');
  });

  it('refuses retry without a verified authenticator (mfa_required)', async () => {
    expect(operationsAccess(adminNoMfa)).toMatchObject({
      canRead: true,
      canManage: false,
      manageDeniedCode: 'mfa_required',
    });
    // Reading stays available through audit.read.
    await expect(listJobs(adminNoMfa, { status: 'dead' })).resolves.toBeDefined();
    const error = await denial(retryJob(adminNoMfa, deadId, 'Provider fixed'));
    expect(error.decision.code).toBe('mfa_required');
    expect((await jobRow(deadId)).status).toBe('dead');
    expect(await auditRows('job.retried', deadId)).toHaveLength(0);
  });

  it('denies customers and other non-staff', async () => {
    expect(operationsAccess(customer)).toMatchObject({ canRead: false, canManage: false });
    await denial(listJobs(customer, { status: 'dead' }));
    await denial(queueSummary(customer));
    await denial(listStuckOutbox(customer));
    await denial(retryJob(customer, deadId, 'Provider fixed'));
  });

  it('requires a reason', async () => {
    await expect(retryJob(admin, deadId, '  x ')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('retries a dead job: pending, attempts 0, due now, audited with the reason', async () => {
    const before = Date.now();
    const retried = await retryJob(admin, deadId, '  Provider credentials fixed  ');
    expect(retried).toMatchObject({ id: deadId, status: 'pending', attempts: 0, lastError: null });
    expect(retried).not.toHaveProperty('payload');
    const row = await jobRow(deadId);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const audits = await auditRows('job.retried', deadId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'job',
      actorUserId: users.admin.id,
      actorType: 'user',
      reason: 'Provider credentials fixed',
      after: { status: 'pending', attempts: 0 },
    });
    expect(audits[0]!.before).toMatchObject({ status: 'dead', attempts: 1 });
    expect(JSON.stringify(audits[0])).not.toContain(PERSONAL_EMAIL);
    expect((await queueSummary(admin)).dead).toBe(0);
  });

  it('answers conflict for a job that is not dead and not_found for an unknown id', async () => {
    const error = await retryJob(admin, deadId, 'Second attempt').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'conflict', status: 409 });
    await expect(
      retryJob(admin, '00000000-0000-4000-8000-000000000000', 'Unknown job'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await auditRows('job.retried', deadId)).toHaveLength(1);
  });

  it('paginates by cursor without gaps or duplicates', async () => {
    const ids = [
      await makeDeadJob('report.render', new Error('renderer crashed'), 'reports'),
      await makeDeadJob('report.email', new Error('mailer unavailable'), 'reports'),
      await makeDeadJob('report.archive', new Error('storage timeout'), 'reports'),
    ];
    const first = await listJobs(admin, { status: 'dead', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listJobs(admin, { status: 'dead', limit: 2, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    await expect(listJobs(admin, { status: 'dead', cursor: 'not-a-cursor' })).rejects.toMatchObject(
      { code: 'validation_failed' },
    );
    // Without a status filter the retried (now pending) job is listed too.
    const all = await listJobs(admin, { limit: 100 });
    expect(all.items.map((i) => i.status)).toEqual(expect.arrayContaining(['dead', 'pending']));
  });
});

describe('stuck outbox events', () => {
  let stuckId: number;

  it('lists unpublished events at the attempt threshold with a count, without payload', async () => {
    await appendOutbox(dbs.owner, {
      eventType: 'lead.created',
      aggregateType: 'lead',
      aggregateId: 'lead-1',
      payload: { email: PERSONAL_EMAIL },
      correlationId: 'corr-outbox',
    });
    await appendOutbox(dbs.owner, {
      eventType: 'lead.updated',
      aggregateType: 'lead',
      aggregateId: 'lead-2',
      payload: { email: PERSONAL_EMAIL },
    });
    const events = await dbs.owner
      .select({ id: schema.outboxEvents.id, eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents);
    stuckId = events.find((e) => e.eventType === 'lead.created')!.id;
    await dbs.owner
      .update(schema.outboxEvents)
      .set({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: 'route failed: api_key=abc123' })
      .where(eq(schema.outboxEvents.id, stuckId));
    // The relay no longer claims it.
    const claimable = await dbs.owner.transaction((tx) => claimOutboxBatch(tx, 50));
    expect(claimable.map((e) => e.id)).not.toContain(stuckId);

    const stuck = await listStuckOutbox(ops, 50);
    expect(stuck.total).toBe(1);
    expect(stuck.threshold).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(stuck.items).toEqual([
      {
        id: stuckId,
        eventType: 'lead.created',
        aggregateType: 'lead',
        aggregateId: 'lead-1',
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: 'route failed: api_key=[redacted]',
        createdAt: expect.any(String),
        correlationId: 'corr-outbox',
      },
    ]);
    expect(JSON.stringify(stuck)).not.toContain(PERSONAL_EMAIL);
    expect((await queueSummary(ops)).outboxStuck).toBe(1);
  });

  it('refuses requeue without platform.settings.manage or without MFA', async () => {
    expect((await denial(requeueOutboxEvent(ops, stuckId, 'Relay fixed'))).decision.code).toBe(
      'no_permission',
    );
    expect(
      (await denial(requeueOutboxEvent(adminNoMfa, stuckId, 'Relay fixed'))).decision.code,
    ).toBe('mfa_required');
  });

  it('requeue resets attempts and error, is audited and makes the event claimable again', async () => {
    const result = await requeueOutboxEvent(admin, stuckId, 'Routing bug fixed in release 42');
    expect(result).toEqual({ id: stuckId, attempts: 0, lastError: null });
    const [row] = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, stuckId));
    expect(row).toMatchObject({ attempts: 0, lastError: null, publishedAt: null });
    const audits = await auditRows('outbox_event.requeued', String(stuckId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'outbox_event',
      actorUserId: users.admin.id,
      reason: 'Routing bug fixed in release 42',
      after: { attempts: 0, lastError: null },
    });
    expect(audits[0]!.before).toMatchObject({
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'route failed: api_key=[redacted]',
    });
    expect((await listStuckOutbox(admin)).total).toBe(0);
    const claimable = await dbs.owner.transaction((tx) => claimOutboxBatch(tx, 50));
    expect(claimable.map((e) => e.id)).toContain(stuckId);
  });

  it('answers conflict for a published event and not_found for an unknown one', async () => {
    await dbs.owner
      .update(schema.outboxEvents)
      .set({ publishedAt: new Date() })
      .where(eq(schema.outboxEvents.id, stuckId));
    await expect(requeueOutboxEvent(admin, stuckId, 'Already out')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(requeueOutboxEvent(admin, 99_999_999, 'Unknown event')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

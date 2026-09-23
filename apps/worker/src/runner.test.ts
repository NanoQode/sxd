import { eq, inArray, like } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, schema, systemContext, withActor, type JobRow } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { JobRunner, NonRetryableJobError, type JobContext, type JobFailure } from './runner';

/**
 * The worker's job runner against the real queue: success, retryable and
 * permanent failures, unknown job types and the actor a handler runs under.
 * Jobs live on a queue unique to this run so parallel suites never see them.
 */

let dbs: TestDatabases;
const run = uniqueSuffix();
const q = `wq_${run}`;
const log = pino({ level: 'silent' });

async function jobRow(id: string): Promise<JobRow> {
  const [row] = await dbs.owner.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  if (!row) throw new Error(`job ${id} missing`);
  return row;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('condition not met in time');
}

beforeAll(() => {
  dbs = connectTestDatabases();
});

afterAll(async () => {
  const mine = await dbs.owner
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(like(schema.jobs.queue, `wq_${run}%`));
  const ids = mine.map((j) => j.id);
  if (ids.length > 0) {
    await dbs.owner.delete(schema.jobFailures).where(inArray(schema.jobFailures.jobId, ids));
    await dbs.owner.delete(schema.jobs).where(inArray(schema.jobs.id, ids));
  }
  await dbs.close();
});

describe('JobRunner', () => {
  it('refuses a duplicate handler registration', () => {
    const runner = new JobRunner({
      db: dbs.app,
      workerId: 'dup',
      queues: [q],
      concurrency: 1,
      pollIntervalMs: 1000,
      log,
    });
    runner.register('x', async () => {});
    expect(() => runner.register('x', async () => {})).toThrow(/duplicate job handler/);
  });

  it('runs handlers under the job actor and records success, retry, dead and unknown types', async () => {
    const seen: Array<Pick<JobContext, 'actor'> & { payload: unknown }> = [];
    const failures: JobFailure[] = [];
    const runner = new JobRunner({
      db: dbs.app,
      workerId: `runner-${run}`,
      queues: [q],
      concurrency: 3,
      pollIntervalMs: 25,
      log,
      onJobFailed: (f) => {
        failures.push(f);
        throw new Error('a broken hook never breaks the queue');
      },
    });
    runner.register('rt.ok', async (ctx) => {
      seen.push({ actor: ctx.actor, payload: ctx.job.payload });
    });
    runner.register('rt.flaky', async () => {
      throw new Error('temporary outage token=abc123');
    });
    runner.register('rt.permanent', async () => {
      throw new NonRetryableJobError('payload can never succeed');
    });

    const enqueue = (type: string, extra: Partial<Parameters<typeof enqueueJob>[1]> = {}) =>
      withActor(dbs.app, systemContext('runner-test'), (tx) =>
        enqueueJob(tx, { type, queue: q, payload: { type }, ...extra }),
      );
    const ok = await enqueue('rt.ok', {
      organizationId: `org_${run}`,
      actorUserId: `user_${run}`,
      correlationId: `corr-${run}`,
    });
    const flaky = await enqueue('rt.flaky', { maxAttempts: 5 });
    const permanent = await enqueue('rt.permanent');
    const unknown = await enqueue('rt.unknown');

    runner.start();
    try {
      await waitFor(async () => {
        const rows = await dbs.owner
          .select({ status: schema.jobs.status, attempts: schema.jobs.attempts })
          .from(schema.jobs)
          .where(inArray(schema.jobs.id, [ok.id, flaky.id, permanent.id, unknown.id]));
        return rows.every((r) => r.status !== 'running' && r.attempts > 0);
      });
    } finally {
      await runner.stop();
    }
    expect(runner.activeCount).toBe(0);

    expect(await jobRow(ok.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload).toEqual({ type: 'rt.ok' });
    // Jobs inherit the organisation, user and correlation id of the business event.
    expect(seen[0]!.actor).toMatchObject({
      organizationId: `org_${run}`,
      userId: `user_${run}`,
      correlationId: `corr-${run}`,
      bypass: true,
    });

    const flakyRow = await jobRow(flaky.id);
    expect(flakyRow).toMatchObject({ status: 'pending', attempts: 1 });
    expect(flakyRow.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(flakyRow.lastError).toBe('temporary outage token=[redacted]');

    expect(await jobRow(permanent.id)).toMatchObject({
      status: 'dead',
      lastError: 'payload can never succeed',
    });
    expect(await jobRow(unknown.id)).toMatchObject({
      status: 'dead',
      lastError: 'no handler for rt.unknown',
    });

    const failureRows = await dbs.owner
      .select()
      .from(schema.jobFailures)
      .where(inArray(schema.jobFailures.jobId, [flaky.id, permanent.id, unknown.id]));
    expect(failureRows).toHaveLength(3);

    // The failure hook sees every failed attempt with its outcome, even though it threw.
    const outcomes = Object.fromEntries(failures.map((f) => [f.job.type, f.outcome]));
    expect(outcomes).toEqual({ 'rt.flaky': 'retry', 'rt.permanent': 'dead', 'rt.unknown': 'dead' });
  });

  it('stops polling after stop() and leaves new jobs pending', async () => {
    const runner = new JobRunner({
      db: dbs.app,
      workerId: `runner-stop-${run}`,
      queues: [`${q}_stop`],
      concurrency: 1,
      pollIntervalMs: 25,
      log,
    });
    runner.register('rt.after-stop', async () => {});
    runner.start();
    await runner.stop();
    const { id } = await withActor(dbs.app, systemContext(), (tx) =>
      enqueueJob(tx, { type: 'rt.after-stop', queue: `${q}_stop`, payload: {} }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect((await jobRow(id)).status).toBe('pending');
  });
});

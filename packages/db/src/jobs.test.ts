import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendOutbox,
  backoffSeconds,
  claimJobs,
  claimOutboxBatch,
  completeJob,
  enqueueJob,
  failJob,
  markOutboxFailed,
  markOutboxPublished,
  OUTBOX_MAX_ATTEMPTS,
  queueDepth,
  reapStaleJobs,
  retryDeadJob,
  sanitizeError,
  type JobRow,
} from './jobs';
import * as s from './schema';
import { systemContext, withActor } from './tenant';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from './testing';

/**
 * Durable job queue and transactional outbox (brief §17). The suite shares
 * the test database with other suites, so every fixture lives on a queue or
 * aggregate id unique to this run, nothing is truncated, and the global
 * operations (stale-lock reaping) run inside a transaction that is rolled back.
 */

let dbs: TestDatabases;
const run = uniqueSuffix();
const worker = `test-worker-${run}`;
const queue = (name: string) => `tq_${run}_${name}`;
const aggregateId = `jobs-test-${run}`;

/** Runs as the worker does: runtime role, system actor (privileged under RLS). */
const sys = <T>(fn: Parameters<typeof withActor<T>>[2]) =>
  withActor(dbs.app, systemContext('jobs-test'), fn);

async function jobById(id: string): Promise<JobRow> {
  const [row] = await dbs.owner.select().from(s.jobs).where(eq(s.jobs.id, id));
  if (!row) throw new Error(`job ${id} not found`);
  return row;
}

class Rollback extends Error {}

beforeAll(() => {
  dbs = connectTestDatabases();
});

afterAll(async () => {
  const mine = await dbs.owner
    .select({ id: s.jobs.id })
    .from(s.jobs)
    .where(like(s.jobs.queue, `tq_${run}_%`));
  const ids = mine.map((j) => j.id);
  if (ids.length > 0) {
    await dbs.owner.delete(s.jobFailures).where(inArray(s.jobFailures.jobId, ids));
    await dbs.owner.delete(s.jobs).where(inArray(s.jobs.id, ids));
  }
  await dbs.owner.delete(s.outboxEvents).where(eq(s.outboxEvents.aggregateId, aggregateId));
  await dbs.close();
});

describe('enqueueJob', () => {
  it('deduplicates on the dedupe key and returns the existing job', async () => {
    const q = queue('dedupe');
    const key = `test:${run}:dedupe`;
    const first = await sys((tx) =>
      enqueueJob(tx, { type: 't.a', queue: q, payload: { n: 1 }, dedupeKey: key }),
    );
    const second = await sys((tx) =>
      enqueueJob(tx, { type: 't.a', queue: q, payload: { n: 2 }, dedupeKey: key }),
    );
    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ id: first.id, deduplicated: true });
    const rows = await dbs.owner.select().from(s.jobs).where(eq(s.jobs.dedupeKey, key));
    expect(rows).toHaveLength(1);
    // The first payload wins; a replay never rewrites the queued job.
    expect(rows[0]!.payload).toEqual({ n: 1 });
  });

  it('creates distinct jobs when no dedupe key is given, with documented defaults', async () => {
    const q = queue('nodedupe');
    const a = await sys((tx) => enqueueJob(tx, { type: 't.b', queue: q, payload: {} }));
    const b = await sys((tx) => enqueueJob(tx, { type: 't.b', queue: q, payload: {} }));
    expect(a.id).not.toBe(b.id);
    const row = await jobById(a.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, maxAttempts: 8, priority: 0 });
  });
});

describe('claimJobs', () => {
  it('claims by priority, then run time, and never a job that is not due yet', async () => {
    const q = queue('order');
    const now = Date.now();
    const low = await sys((tx) =>
      enqueueJob(tx, { type: 't.low', queue: q, payload: {}, runAt: new Date(now - 180_000) }),
    );
    const highLate = await sys((tx) =>
      enqueueJob(tx, {
        type: 't.high-late',
        queue: q,
        payload: {},
        priority: 5,
        runAt: new Date(now - 60_000),
      }),
    );
    const highEarly = await sys((tx) =>
      enqueueJob(tx, {
        type: 't.high-early',
        queue: q,
        payload: {},
        priority: 5,
        runAt: new Date(now - 120_000),
      }),
    );
    const future = await sys((tx) =>
      enqueueJob(tx, { type: 't.future', queue: q, payload: {}, runAt: new Date(now + 3_600_000) }),
    );

    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const claimed = await sys((tx) => claimJobs(tx, { workerId: worker, queues: [q], limit: 1 }));
      if (claimed.length === 0) break;
      order.push(claimed[0]!.id);
    }
    expect(order).toEqual([highEarly.id, highLate.id, low.id]);

    const claimed = await jobById(highEarly.id);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, lockedBy: worker });
    expect(claimed.lockedAt).toBeInstanceOf(Date);
    expect((await jobById(future.id)).status).toBe('pending');

    // With an explicit clock past its run time the future job becomes claimable.
    const later = await sys((tx) =>
      claimJobs(tx, {
        workerId: worker,
        queues: [q],
        limit: 5,
        now: new Date(now + 2 * 3_600_000),
      }),
    );
    expect(later.map((j) => j.id)).toEqual([future.id]);
    // Rows come back in the Drizzle (camelCase) shape.
    expect(later[0]).toMatchObject({ type: 't.future', queue: q, maxAttempts: 8, attempts: 1 });
  });

  it('only claims from the requested queues', async () => {
    const a = queue('qa');
    const b = queue('qb');
    const inA = await sys((tx) => enqueueJob(tx, { type: 't.qa', queue: a, payload: {} }));
    await sys((tx) => enqueueJob(tx, { type: 't.qb', queue: b, payload: {} }));
    const claimed = await sys((tx) => claimJobs(tx, { workerId: worker, queues: [a], limit: 10 }));
    expect(claimed.map((j) => j.id)).toEqual([inA.id]);
  });

  it('skips rows locked by another claimer (FOR UPDATE SKIP LOCKED)', async () => {
    const q = queue('locked');
    const first = await sys((tx) =>
      enqueueJob(tx, { type: 't.l1', queue: q, payload: {}, priority: 9 }),
    );
    const second = await sys((tx) => enqueueJob(tx, { type: 't.l2', queue: q, payload: {} }));
    await sys(async (tx1) => {
      const mine = await claimJobs(tx1, { workerId: `${worker}-1`, queues: [q], limit: 1 });
      expect(mine.map((j) => j.id)).toEqual([first.id]);
      // tx1 still holds the row lock; a second connection must skip it, not wait for it.
      const theirs = await sys((tx2) =>
        claimJobs(tx2, { workerId: `${worker}-2`, queues: [q], limit: 5 }),
      );
      expect(theirs.map((j) => j.id)).toEqual([second.id]);
    });
  });

  it('never hands the same job to two concurrent claimers', async () => {
    const q = queue('race');
    const created: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const { id } = await sys((tx) =>
        enqueueJob(tx, { type: 't.race', queue: q, payload: { i } }),
      );
      created.push(id);
    }
    const seen: string[] = [];
    for (let round = 0; round < 10 && seen.length < created.length; round += 1) {
      const batches = await Promise.all(
        [0, 1, 2, 3].map((n) =>
          sys((tx) => claimJobs(tx, { workerId: `${worker}-race-${n}`, queues: [q], limit: 4 })),
        ),
      );
      for (const batch of batches) seen.push(...batch.map((j) => j.id));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...created].sort());
    const rows = await dbs.owner.select().from(s.jobs).where(eq(s.jobs.queue, q));
    expect(rows.every((r) => r.status === 'running' && r.attempts === 1)).toBe(true);
  });
});

describe('completeJob and failJob', () => {
  async function claimOne(q: string, now?: Date): Promise<JobRow> {
    const [job] = await sys((tx) =>
      claimJobs(tx, { workerId: worker, queues: [q], limit: 1, now }),
    );
    if (!job) throw new Error('nothing to claim');
    return job;
  }

  it('completes a job: succeeded, lock released, error cleared', async () => {
    const q = queue('complete');
    await sys((tx) => enqueueJob(tx, { type: 't.ok', queue: q, payload: {} }));
    const job = await claimOne(q);
    await sys((tx) => completeJob(tx, job.id));
    const row = await jobById(job.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it('retries with exponential backoff, records every attempt, then goes dead at maxAttempts', async () => {
    const q = queue('fail');
    const { id } = await sys((tx) =>
      enqueueJob(tx, { type: 't.flaky', queue: q, payload: {}, maxAttempts: 3 }),
    );
    const secret = new Error(
      'provider said no: Authorization Bearer abc.def-123 password=hunter2 key sk_live_9f8e7d6c',
    );

    let job = await claimOne(q);
    const before = Date.now();
    expect(await sys((tx) => failJob(tx, job, secret))).toBe('retry');
    let row = await jobById(id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lockedAt: null, lockedBy: null });
    // Attempt 1 → 30 s plus up to 20% jitter.
    const delay = (row.runAt.getTime() - before) / 1000;
    expect(delay).toBeGreaterThanOrEqual(29);
    expect(delay).toBeLessThan(37 + 5);
    expect(row.lastError).not.toMatch(/hunter2|abc\.def-123|9f8e7d6c/);
    expect(row.lastError).toContain('Bearer [redacted]');

    // Not due yet: a claim now finds nothing; a claim past the backoff finds it.
    expect(await sys((tx) => claimJobs(tx, { workerId: worker, queues: [q], limit: 1 }))).toEqual(
      [],
    );
    const future = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    job = await claimOne(q, future(5));
    expect(job.attempts).toBe(2);
    expect(await sys((tx) => failJob(tx, job, secret))).toBe('retry');
    row = await jobById(id);
    const secondDelay = (row.runAt.getTime() - Date.now()) / 1000;
    expect(secondDelay).toBeGreaterThan(50); // 60 s base for attempt 2

    job = await claimOne(q, future(10));
    expect(job.attempts).toBe(3);
    expect(await sys((tx) => failJob(tx, job, secret))).toBe('dead');
    row = await jobById(id);
    expect(row).toMatchObject({ status: 'dead', attempts: 3, lockedAt: null, lockedBy: null });

    const failures = await dbs.owner
      .select()
      .from(s.jobFailures)
      .where(eq(s.jobFailures.jobId, id))
      .orderBy(s.jobFailures.attempt);
    expect(failures.map((f) => f.attempt)).toEqual([1, 2, 3]);
    for (const f of failures) {
      expect(f.errorMessageSanitized).not.toMatch(/hunter2|abc\.def-123|9f8e7d6c/);
      expect(f.stackSanitized?.split('\n').length ?? 0).toBeLessThanOrEqual(12);
    }

    // A dead job is never claimed again until an operator retries it.
    expect(
      await sys((tx) =>
        claimJobs(tx, { workerId: worker, queues: [q], limit: 1, now: future(600) }),
      ),
    ).toEqual([]);
    expect(await sys((tx) => retryDeadJob(tx, id))).toBe(true);
    expect(await jobById(id)).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    expect(await sys((tx) => retryDeadJob(tx, id))).toBe(false);
  });

  it('goes straight to dead for a non-retryable failure', async () => {
    const q = queue('permanent');
    await sys((tx) => enqueueJob(tx, { type: 't.permanent', queue: q, payload: {} }));
    const job = await claimOne(q);
    expect(await sys((tx) => failJob(tx, job, 'bad payload', { retry: false }))).toBe('dead');
    const row = await jobById(job.id);
    expect(row).toMatchObject({ status: 'dead', attempts: 1, lastError: 'bad payload' });
    const failures = await dbs.owner
      .select()
      .from(s.jobFailures)
      .where(eq(s.jobFailures.jobId, job.id));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempt: 1, stackSanitized: null });
  });
});

describe('backoffSeconds', () => {
  it('doubles from 30 s with bounded jitter and caps at one hour', () => {
    for (let i = 0; i < 50; i += 1) {
      const one = backoffSeconds(1);
      expect(one).toBeGreaterThanOrEqual(30);
      expect(one).toBeLessThan(36);
      const two = backoffSeconds(2);
      expect(two).toBeGreaterThanOrEqual(60);
      expect(two).toBeLessThan(72);
      const capped = backoffSeconds(20);
      expect(capped).toBeGreaterThanOrEqual(3600);
      expect(capped).toBeLessThan(3630);
    }
    expect(backoffSeconds(0)).toBeGreaterThanOrEqual(30);
  });
});

describe('reapStaleJobs', () => {
  it('releases running jobs whose lock is older than the cutoff and leaves fresh locks alone', async () => {
    const q = queue('reap');
    const stale = await sys((tx) => enqueueJob(tx, { type: 't.stale', queue: q, payload: {} }));
    const fresh = await sys((tx) => enqueueJob(tx, { type: 't.fresh', queue: q, payload: {} }));
    await sys((tx) => claimJobs(tx, { workerId: worker, queues: [q], limit: 2 }));
    await dbs.owner
      .update(s.jobs)
      .set({ lockedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(s.jobs.id, stale.id));

    // Reaping is global; roll it back so other suites' rows are untouched.
    await expect(
      sys(async (tx) => {
        const released = await reapStaleJobs(tx, 15 * 60_000);
        expect(released).toBeGreaterThanOrEqual(1);
        const rows = await tx
          .select()
          .from(s.jobs)
          .where(inArray(s.jobs.id, [stale.id, fresh.id]));
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(stale.id)).toMatchObject({
          status: 'pending',
          lockedAt: null,
          lockedBy: null,
          lastError: 'released stale lock',
          attempts: 1,
        });
        expect(byId.get(fresh.id)).toMatchObject({ status: 'running', lockedBy: worker });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});

describe('outbox', () => {
  async function append(eventType: string): Promise<number> {
    await sys((tx) =>
      appendOutbox(tx, {
        eventType,
        aggregateType: 'jobs_test',
        aggregateId,
        payload: { eventType },
        correlationId: `corr-${run}`,
      }),
    );
    const [row] = await dbs.owner
      .select({ id: s.outboxEvents.id })
      .from(s.outboxEvents)
      .where(
        and(eq(s.outboxEvents.aggregateId, aggregateId), eq(s.outboxEvents.eventType, eventType)),
      );
    return row!.id;
  }

  /** Claims inside a transaction that is rolled back: claiming only locks rows. */
  async function claimedIds(): Promise<Set<number>> {
    const ids = new Set<number>();
    await sys(async (tx) => {
      const rows = await claimOutboxBatch(tx, 100_000);
      for (const r of rows) ids.add(r.id);
    });
    return ids;
  }

  it('lets any actor append (no RETURNING), claims in id order and maps rows to camelCase', async () => {
    // A customer context may append even though it cannot read the table back.
    await withActor(
      dbs.app,
      { userId: null, organizationId: null, staff: false, correlationId: 'c' },
      (tx) =>
        appendOutbox(tx, {
          eventType: 'jobs_test.anonymous',
          aggregateType: 'jobs_test',
          aggregateId,
          payload: {},
        }),
    );
    const a = await append('jobs_test.a');
    const b = await append('jobs_test.b');
    expect(b).toBeGreaterThan(a);
    await sys(async (tx) => {
      const rows = (await claimOutboxBatch(tx, 100_000)).filter(
        (r) => r.aggregateId === aggregateId,
      );
      const ids = rows.map((r) => r.id);
      expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
      expect(rows.find((r) => r.id === a)).toMatchObject({
        eventType: 'jobs_test.a',
        aggregateType: 'jobs_test',
        payload: { eventType: 'jobs_test.a' },
        correlationId: `corr-${run}`,
        publishedAt: null,
        attempts: 0,
      });
    });
  });

  it('skips events locked by a concurrent relay', async () => {
    const id = await append('jobs_test.locked');
    await sys(async (tx1) => {
      const first = await claimOutboxBatch(tx1, 100_000);
      expect(first.map((r) => r.id)).toContain(id);
      const second = await sys((tx2) => claimOutboxBatch(tx2, 100_000));
      expect(second.map((r) => r.id)).not.toContain(id);
    });
  });

  it('marks events published so they are not claimed again', async () => {
    const id = await append('jobs_test.publish');
    expect(await claimedIds()).toContain(id);
    await sys((tx) => markOutboxPublished(tx, [id]));
    await sys((tx) => markOutboxPublished(tx, [])); // no-op
    const [row] = await dbs.owner.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, id));
    expect(row!.publishedAt).toBeInstanceOf(Date);
    expect(await claimedIds()).not.toContain(id);
  });

  it('counts failed routing attempts and stops claiming at OUTBOX_MAX_ATTEMPTS', async () => {
    const id = await append('jobs_test.failing');
    await sys((tx) => markOutboxFailed(tx, id, new Error('route failed token=abc123secret')));
    let [row] = await dbs.owner.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, id));
    expect(row).toMatchObject({ attempts: 1, publishedAt: null });
    expect(row!.lastError).toBe('route failed token=[redacted]');

    await dbs.owner
      .update(s.outboxEvents)
      .set({ attempts: OUTBOX_MAX_ATTEMPTS - 2 })
      .where(eq(s.outboxEvents.id, id));
    await sys((tx) => markOutboxFailed(tx, id, 'still failing'));
    expect(await claimedIds()).toContain(id); // attempts = max - 1
    await sys((tx) => markOutboxFailed(tx, id, 'still failing'));
    [row] = await dbs.owner.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, id));
    expect(row!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(await claimedIds()).not.toContain(id); // stuck until an operator requeues it
  });
});

describe('queueDepth', () => {
  it('reports counts and the age of the oldest due pending job', async () => {
    const q = queue('depth');
    await sys((tx) =>
      enqueueJob(tx, {
        type: 't.old',
        queue: q,
        payload: {},
        runAt: new Date(Date.now() - 900_000),
      }),
    );
    const depth = await sys((tx) => queueDepth(tx));
    expect(depth.pending).toBeGreaterThanOrEqual(1);
    expect(depth.oldestPendingSeconds).toBeGreaterThanOrEqual(899);
    for (const key of ['running', 'dead', 'outboxUnpublished'] as const) {
      expect(Number.isInteger(depth[key])).toBe(true);
    }
  });
});

describe('sanitizeError', () => {
  it('redacts keys, bearer tokens and credential query parameters', () => {
    expect(sanitizeError(new Error('sk_test_abcDEF123 pk_live_zz9'))).toBe(
      'sk_test_[redacted] pk_live_[redacted]',
    );
    expect(sanitizeError('Authorization: Bearer eyJhbGciOi.x-y_z')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(sanitizeError('GET /x?api_key=k1&password=p2&secret=s3&token=t4 failed')).toBe(
      'GET /x?api_key=[redacted]&password=[redacted]&secret=[redacted]&token=[redacted] failed',
    );
    expect(sanitizeError({ code: 42 })).toBe('{"code":42}');
  });
});

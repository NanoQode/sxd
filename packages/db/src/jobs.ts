import { and, asc, eq, isNull, lt, lte, sql } from 'drizzle-orm';
import type { DbExecutor, Transaction } from './client';
import * as s from './schema';

/**
 * Durable job queue and transactional outbox on PostgreSQL.
 *
 * - `appendOutbox` and `enqueueJob` are called inside the same transaction as
 *   the business change, so a job exists if and only if the change committed.
 * - The worker claims jobs with FOR UPDATE SKIP LOCKED, retries with
 *   exponential backoff, and moves exhausted jobs to `dead` for admin retry.
 */

export interface EnqueueJobInput {
  type: string;
  payload: Record<string, unknown>;
  queue?: string;
  organizationId?: string | null;
  actorUserId?: string | null;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string | null;
  correlationId?: string | null;
}

export async function enqueueJob(
  tx: DbExecutor,
  input: EnqueueJobInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const rows = await tx
    .insert(s.jobs)
    .values({
      type: input.type,
      payload: input.payload,
      queue: input.queue ?? 'default',
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      runAt: input.runAt ?? new Date(),
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 8,
      dedupeKey: input.dedupeKey ?? null,
      correlationId: input.correlationId ?? null,
    })
    .onConflictDoNothing({ target: s.jobs.dedupeKey })
    .returning({ id: s.jobs.id });
  if (rows.length === 0) {
    const existing = await tx
      .select({ id: s.jobs.id })
      .from(s.jobs)
      .where(eq(s.jobs.dedupeKey, input.dedupeKey!));
    return { id: existing[0]!.id, deduplicated: true };
  }
  return { id: rows[0]!.id, deduplicated: false };
}

export interface OutboxInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export async function appendOutbox(tx: DbExecutor, input: OutboxInput): Promise<number> {
  const [row] = await tx
    .insert(s.outboxEvents)
    .values({
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      correlationId: input.correlationId ?? null,
    })
    .returning({ id: s.outboxEvents.id });
  return row!.id;
}

export type JobRow = typeof s.jobs.$inferSelect;

/** Exponential backoff with jitter: 30s, 60s, 120s ... capped at 1 hour. */
export function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(30, base * 0.2));
  return base + jitter;
}

export async function claimJobs(
  tx: Transaction,
  opts: { workerId: string; queues: string[]; limit: number; now?: Date },
): Promise<JobRow[]> {
  const now = opts.now ?? new Date();
  const rows = await tx.execute<JobRow>(sql`
    UPDATE jobs SET status = 'running', locked_at = ${now}, locked_by = ${opts.workerId}, attempts = attempts + 1, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= ${now} AND queue = ANY(${opts.queues}::text[])
      ORDER BY priority DESC, run_at ASC
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  // Raw rows come back snake_cased; normalise to the Drizzle shape.
  return rows.rows.map((r) => normalizeJobRow(r as unknown as Record<string, unknown>));
}

function normalizeJobRow(r: Record<string, unknown>): JobRow {
  const pick = <T>(camel: string, snake: string): T => (r[camel] ?? r[snake]) as T;
  return {
    id: pick('id', 'id'),
    queue: pick('queue', 'queue'),
    type: pick('type', 'type'),
    payload: pick('payload', 'payload'),
    organizationId: pick('organizationId', 'organization_id'),
    actorUserId: pick('actorUserId', 'actor_user_id'),
    status: pick('status', 'status'),
    priority: pick('priority', 'priority'),
    runAt: pick('runAt', 'run_at'),
    lockedAt: pick('lockedAt', 'locked_at'),
    lockedBy: pick('lockedBy', 'locked_by'),
    attempts: pick('attempts', 'attempts'),
    maxAttempts: pick('maxAttempts', 'max_attempts'),
    lastError: pick('lastError', 'last_error'),
    dedupeKey: pick('dedupeKey', 'dedupe_key'),
    correlationId: pick('correlationId', 'correlation_id'),
    completedAt: pick('completedAt', 'completed_at'),
    createdAt: pick('createdAt', 'created_at'),
    updatedAt: pick('updatedAt', 'updated_at'),
  };
}

export async function completeJob(db: DbExecutor, jobId: string): Promise<void> {
  await db
    .update(s.jobs)
    .set({
      status: 'succeeded',
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    })
    .where(eq(s.jobs.id, jobId));
}

export async function failJob(
  db: DbExecutor,
  job: JobRow,
  error: unknown,
  opts: { retry?: boolean } = {},
): Promise<'retry' | 'dead'> {
  const message = sanitizeError(error);
  await db.insert(s.jobFailures).values({
    jobId: job.id,
    attempt: job.attempts,
    errorMessageSanitized: message.slice(0, 2000),
    stackSanitized:
      error instanceof Error && error.stack
        ? error.stack.split('\n').slice(0, 12).join('\n')
        : null,
  });
  const canRetry = (opts.retry ?? true) && job.attempts < job.maxAttempts;
  if (canRetry) {
    const delay = backoffSeconds(job.attempts);
    await db
      .update(s.jobs)
      .set({
        status: 'pending',
        runAt: new Date(Date.now() + delay * 1000),
        lockedAt: null,
        lockedBy: null,
        lastError: message.slice(0, 500),
      })
      .where(eq(s.jobs.id, job.id));
    return 'retry';
  }
  await db
    .update(s.jobs)
    .set({ status: 'dead', lockedAt: null, lockedBy: null, lastError: message.slice(0, 500) })
    .where(eq(s.jobs.id, job.id));
  return 'dead';
}

/** Admin action: put a dead job back on the queue. */
export async function retryDeadJob(db: DbExecutor, jobId: string): Promise<boolean> {
  const rows = await db
    .update(s.jobs)
    .set({ status: 'pending', runAt: new Date(), attempts: 0, lastError: null })
    .where(and(eq(s.jobs.id, jobId), eq(s.jobs.status, 'dead')))
    .returning({ id: s.jobs.id });
  return rows.length > 0;
}

/** Releases jobs whose worker died mid-run (stale lock). */
export async function reapStaleJobs(db: DbExecutor, staleAfterMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(s.jobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null, lastError: 'released stale lock' })
    .where(and(eq(s.jobs.status, 'running'), lt(s.jobs.lockedAt, cutoff)))
    .returning({ id: s.jobs.id });
  return rows.length;
}

export type OutboxRow = typeof s.outboxEvents.$inferSelect;

export async function claimOutboxBatch(tx: Transaction, limit: number): Promise<OutboxRow[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM outbox_events WHERE published_at IS NULL AND attempts < 20
    ORDER BY id ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
  `);
  return rows.rows.map((r) => ({
    id: Number(r['id']),
    eventType: r['event_type'] as string,
    aggregateType: r['aggregate_type'] as string,
    aggregateId: r['aggregate_id'] as string,
    organizationId: (r['organization_id'] as string | null) ?? null,
    actorUserId: (r['actor_user_id'] as string | null) ?? null,
    payload: r['payload'],
    correlationId: (r['correlation_id'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
    publishedAt: (r['published_at'] as Date | null) ?? null,
    attempts: Number(r['attempts'] ?? 0),
    lastError: (r['last_error'] as string | null) ?? null,
  }));
}

export async function markOutboxPublished(tx: DbExecutor, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(s.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(sql`${s.outboxEvents.id} = ANY(${ids}::bigint[])`);
}

export async function markOutboxFailed(tx: DbExecutor, id: number, error: unknown): Promise<void> {
  await tx
    .update(s.outboxEvents)
    .set({
      attempts: sql`${s.outboxEvents.attempts} + 1`,
      lastError: sanitizeError(error).slice(0, 500),
    })
    .where(eq(s.outboxEvents.id, id));
}

export async function queueDepth(
  db: DbExecutor,
): Promise<{
  pending: number;
  running: number;
  dead: number;
  outboxUnpublished: number;
  oldestPendingSeconds: number | null;
}> {
  const jobsAgg = await db.execute<{ status: string; n: string }>(
    sql`select status, count(*)::text as n from jobs group by status`,
  );
  const counts: Record<string, number> = {};
  for (const r of jobsAgg.rows) counts[r.status] = Number(r.n);
  const outbox = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from outbox_events where published_at is null`,
  );
  const oldest = await db
    .select({ runAt: s.jobs.runAt })
    .from(s.jobs)
    .where(
      and(eq(s.jobs.status, 'pending'), lte(s.jobs.runAt, new Date()), isNull(s.jobs.lockedAt)),
    )
    .orderBy(asc(s.jobs.runAt))
    .limit(1);
  return {
    pending: counts['pending'] ?? 0,
    running: counts['running'] ?? 0,
    dead: counts['dead'] ?? 0,
    outboxUnpublished: Number(outbox.rows[0]?.n ?? 0),
    oldestPendingSeconds: oldest[0]
      ? Math.max(0, Math.round((Date.now() - oldest[0].runAt.getTime()) / 1000))
      : null,
  };
}

/** Strips anything that looks like a token or key from error text. */
export function sanitizeError(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);
  return text
    .replace(/(sk|pk)_(test|live)_[A-Za-z0-9]+/g, '$1_$2_[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(password|secret|token|api_key|apikey)=([^&\s]+)/gi, '$1=[redacted]');
}

import 'server-only';
import { and, asc, desc, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  reasonSchema,
  type AdminJobDto,
  type AdminJobListQuery,
  type AdminJobListResponse,
  type JobStatus,
  type OutboxRequeueResult,
  type QueueSummaryDto,
  type StuckOutboxListResponse,
} from '@simplexd/contracts';
import {
  OUTBOX_MAX_ATTEMPTS,
  queueDepth,
  retryDeadJob,
  sanitizeError,
  schema,
  type Transaction,
} from '@simplexd/db';
import {
  assertAllowed,
  authorizeStaff,
  type DenyCode,
  type StaffPermission,
} from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import { authorize, notFound, transact, type AdminContext } from '../context';

/**
 * Admin operations over the durable job queue and the transactional outbox:
 * dead-letter review and retry, and requeueing outbox events the relay has
 * stopped claiming. Both tables are privileged-only under row-level security;
 * the staff transaction context (`transact`) satisfies that policy.
 *
 * Reading needs `audit.read` or `platform.settings.manage` (the dashboard's
 * operations gate). Retry and requeue need `platform.settings.manage`, which
 * the domain policy gates behind a verified authenticator. Payloads may hold
 * personal data: they never leave the database, only their top-level keys do.
 */

export const OPERATIONS_READ_PERMISSIONS: readonly StaffPermission[] = [
  'audit.read',
  'platform.settings.manage',
];
export const OPERATIONS_MANAGE_PERMISSION: StaffPermission = 'platform.settings.manage';

export interface OperationsAccess {
  canRead: boolean;
  canManage: boolean;
  /** Why retry/requeue is refused (e.g. `mfa_required`), or null when allowed. */
  manageDeniedCode: DenyCode | null;
}

/** What the viewer may do on the operations screen; evaluates policy only, no database access. */
export function operationsAccess(ctx: AdminContext): OperationsAccess {
  const actor = ctx.identity.actor;
  const canRead = OPERATIONS_READ_PERMISSIONS.some((p) => authorizeStaff(actor, p).allowed);
  const manage = authorizeStaff(actor, OPERATIONS_MANAGE_PERMISSION);
  return {
    canRead,
    canManage: manage.allowed,
    manageDeniedCode: manage.allowed ? null : manage.code,
  };
}

/** Allows the read if any read permission passes; otherwise reports the most actionable denial. */
function authorizeRead(ctx: AdminContext): void {
  if (!ctx.identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const decisions = OPERATIONS_READ_PERMISSIONS.map((p) => authorizeStaff(ctx.identity.actor, p));
  if (decisions.some((d) => d.allowed)) return;
  const denied = decisions.find((d) => !d.allowed && d.code === 'mfa_required') ?? decisions[0]!;
  assertAllowed(denied);
}

function requireReason(reason: string): string {
  const parsed = reasonSchema.safeParse(reason);
  if (!parsed.success)
    throw new ApiError('validation_failed', 'a reason of 3 to 500 characters is required', {
      details: [{ path: 'reason', message: 'must be 3 to 500 characters' }],
    });
  return parsed.data;
}

const cleanError = (value: string | null): string | null =>
  value ? sanitizeError(value).slice(0, 500) : null;

const j = schema.jobs;
const o = schema.outboxEvents;

/** Unpublished events at or above the attempt threshold, which the relay's claim query skips. */
function stuckOutboxWhere(): SQL {
  return and(isNull(o.publishedAt), gte(o.attempts, OUTBOX_MAX_ATTEMPTS))!;
}

/* ---------------------------------------------------------------------- */
/* Jobs                                                                    */
/* ---------------------------------------------------------------------- */

/** Selected job columns; `payload` itself is deliberately absent. */
const jobColumns = {
  id: j.id,
  queue: j.queue,
  type: j.type,
  status: j.status,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  lastError: j.lastError,
  runAt: j.runAt,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
  correlationId: j.correlationId,
  organizationId: j.organizationId,
  payloadKeys: sql<string[]>`case when jsonb_typeof(${j.payload}) = 'object'
    then coalesce((select array_agg(k order by k) from jsonb_object_keys(${j.payload}) as k), '{}'::text[])
    else '{}'::text[] end`,
  /** Exact (microsecond) sort key for the cursor. */
  cursorAt: sql<string>`to_char(${j.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

interface JobSelection {
  id: string;
  queue: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: Date;
  createdAt: Date;
  updatedAt: Date;
  correlationId: string | null;
  organizationId: string | null;
  payloadKeys: string[] | null;
}

function toJobDto(r: JobSelection): AdminJobDto {
  return {
    id: r.id,
    queue: r.queue,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    lastError: cleanError(r.lastError),
    runAt: r.runAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    correlationId: r.correlationId,
    organizationId: r.organizationId,
    payloadKeys: Array.isArray(r.payloadKeys) ? r.payloadKeys : [],
  };
}

const CURSOR_ID = /^[0-9a-f-]{36}$/i;

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !CURSOR_ID.test(id) || Number.isNaN(new Date(at).getTime()))
    throw new ApiError('validation_failed', 'invalid cursor');
  return { at, id };
}

async function loadJob(tx: Transaction, jobId: string): Promise<AdminJobDto | null> {
  const rows = await tx.select(jobColumns).from(j).where(eq(j.id, jobId));
  return rows[0] ? toJobDto(rows[0]) : null;
}

/** Jobs by status, most recently changed first, cursor-paginated. Payloads are never returned. */
export async function listJobs(
  ctx: AdminContext,
  query: Pick<AdminJobListQuery, 'status' | 'cursor'> & { limit?: number },
): Promise<AdminJobListResponse> {
  authorizeRead(ctx);
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const clauses: SQL[] = [];
  if (query.status) clauses.push(eq(j.status, query.status));
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    clauses.push(sql`(${j.updatedAt}, ${j.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`);
  }
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select(jobColumns)
      .from(j)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(j.updatedAt), desc(j.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toJobDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  });
}

/** Queue depth (wraps `queueDepth`) plus the number of outbox events the relay skips. */
export async function queueSummary(ctx: AdminContext): Promise<QueueSummaryDto> {
  authorizeRead(ctx);
  return transact(ctx, async (tx) => {
    const depth = await queueDepth(tx);
    const stuck = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.outboxEvents)
      .where(stuckOutboxWhere());
    return {
      ...depth,
      outboxStuck: stuck[0]?.n ?? 0,
      outboxStuckThreshold: OUTBOX_MAX_ATTEMPTS,
    };
  });
}

/**
 * Puts a dead job back on the queue (pending, attempts 0, due now) and
 * records who did it and why. Only dead jobs qualify.
 */
export async function retryJob(
  ctx: AdminContext,
  jobId: string,
  reason: string,
): Promise<AdminJobDto> {
  authorize(ctx, OPERATIONS_MANAGE_PERMISSION);
  const why = requireReason(reason);
  return transact(ctx, async (tx) => {
    const [current] = await tx
      .select({
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        lastError: j.lastError,
        type: j.type,
        queue: j.queue,
        organizationId: j.organizationId,
      })
      .from(j)
      .where(eq(j.id, jobId))
      .for('update');
    if (!current) throw notFound('job');
    if (current.status !== 'dead')
      throw new ApiError('conflict', `only dead jobs can be retried; this job is ${current.status}`, {
        details: { status: current.status },
      });
    if (!(await retryDeadJob(tx, jobId)))
      throw new ApiError('conflict', 'the job changed while retrying; reload and try again');
    await recordAudit(tx, ctx.identity, {
      action: 'job.retried',
      entityType: 'job',
      entityId: jobId,
      organizationId: current.organizationId,
      before: {
        status: current.status,
        attempts: current.attempts,
        maxAttempts: current.maxAttempts,
        lastError: cleanError(current.lastError),
        type: current.type,
        queue: current.queue,
      },
      after: { status: 'pending', attempts: 0 },
      reason: why,
      correlationId: ctx.correlationId,
    });
    const updated = await loadJob(tx, jobId);
    if (!updated) throw notFound('job');
    return updated;
  });
}

/* ---------------------------------------------------------------------- */
/* Outbox                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Unpublished events that reached the attempt threshold: the relay's claim
 * query skips them, so they wait here for an operator. Oldest first.
 */
export async function listStuckOutbox(
  ctx: AdminContext,
  limit = 50,
): Promise<StuckOutboxListResponse> {
  authorizeRead(ctx);
  const take = Math.min(Math.max(limit, 1), 100);
  return transact(ctx, async (tx) => {
    const [rows, total] = await Promise.all([
      tx
        .select({
          id: o.id,
          eventType: o.eventType,
          aggregateType: o.aggregateType,
          aggregateId: o.aggregateId,
          attempts: o.attempts,
          lastError: o.lastError,
          createdAt: o.createdAt,
          correlationId: o.correlationId,
        })
        .from(o)
        .where(stuckOutboxWhere())
        .orderBy(asc(o.id))
        .limit(take),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(o)
        .where(stuckOutboxWhere()),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        attempts: r.attempts,
        lastError: cleanError(r.lastError),
        createdAt: r.createdAt.toISOString(),
        correlationId: r.correlationId,
      })),
      total: total[0]?.n ?? 0,
      threshold: OUTBOX_MAX_ATTEMPTS,
    };
  });
}

/** Resets an unpublished event's attempts and error so the relay claims it again. */
export async function requeueOutboxEvent(
  ctx: AdminContext,
  eventId: number,
  reason: string,
): Promise<OutboxRequeueResult> {
  authorize(ctx, OPERATIONS_MANAGE_PERMISSION);
  const why = requireReason(reason);
  return transact(ctx, async (tx) => {
    const [current] = await tx
      .select({
        publishedAt: o.publishedAt,
        attempts: o.attempts,
        lastError: o.lastError,
        eventType: o.eventType,
        aggregateType: o.aggregateType,
        aggregateId: o.aggregateId,
        organizationId: o.organizationId,
      })
      .from(o)
      .where(eq(o.id, eventId))
      .for('update');
    if (!current) throw notFound('outbox event');
    if (current.publishedAt)
      throw new ApiError('conflict', 'this outbox event is already published', {
        details: { publishedAt: current.publishedAt.toISOString() },
      });
    await tx.update(o).set({ attempts: 0, lastError: null }).where(eq(o.id, eventId));
    await recordAudit(tx, ctx.identity, {
      action: 'outbox_event.requeued',
      entityType: 'outbox_event',
      entityId: String(eventId),
      organizationId: current.organizationId,
      before: {
        attempts: current.attempts,
        lastError: cleanError(current.lastError),
        eventType: current.eventType,
        aggregateType: current.aggregateType,
        aggregateId: current.aggregateId,
      },
      after: { attempts: 0, lastError: null },
      reason: why,
      correlationId: ctx.correlationId,
    });
    return { id: eventId, attempts: 0, lastError: null };
  });
}

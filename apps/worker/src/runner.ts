import type { Logger } from 'pino';
import {
  claimJobs,
  completeJob,
  failJob,
  systemContext,
  withActor,
  type Database,
  type JobRow,
} from '@simplexd/db';

export interface JobContext {
  db: Database;
  job: JobRow;
  log: Logger;
  /** Actor context for tenant-scoped work; jobs inherit the organisation of the business event. */
  actor: ReturnType<typeof systemContext> & {
    organizationId: string | null;
    userId: string | null;
  };
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/** Thrown by handlers for permanent failures that must not be retried. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

export interface JobRunnerOptions {
  db: Database;
  workerId: string;
  queues: string[];
  concurrency: number;
  pollIntervalMs: number;
  log: Logger;
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: JobRunnerOptions) {}

  get queues(): string[] {
    return this.opts.queues;
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new Error(`duplicate job handler for ${type}`);
    this.handlers.set(type, handler);
  }

  start(): void {
    this.running = true;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const capacity = this.opts.concurrency - this.inFlight.size;
      if (capacity > 0) {
        const jobs = await withActor(this.opts.db, systemContext('worker-claim'), (tx) =>
          claimJobs(tx, {
            workerId: this.opts.workerId,
            queues: this.opts.queues,
            limit: capacity,
          }),
        );
        for (const job of jobs) {
          const p = this.execute(job).finally(() => this.inFlight.delete(p));
          this.inFlight.add(p);
        }
        if (jobs.length === capacity) {
          this.timer = setTimeout(() => void this.tick(), 10);
          return;
        }
      }
    } catch (err) {
      this.opts.log.error({ err }, 'job polling failed');
    }
    this.timer = setTimeout(() => void this.tick(), this.opts.pollIntervalMs);
  }

  private async execute(job: JobRow): Promise<void> {
    const log = this.opts.log.child({
      jobId: job.id,
      jobType: job.type,
      attempt: job.attempts,
      correlationId: job.correlationId ?? undefined,
    });
    const handler = this.handlers.get(job.type);
    if (!handler) {
      log.error('no handler registered');
      await withActor(this.opts.db, systemContext(), (tx) =>
        failJob(tx, job, new Error(`no handler for ${job.type}`), { retry: false }),
      );
      return;
    }
    const started = Date.now();
    try {
      const actor = {
        ...systemContext(job.correlationId ?? undefined),
        organizationId: job.organizationId,
        userId: job.actorUserId,
      };
      await handler({ db: this.opts.db, job, log, actor });
      await withActor(this.opts.db, systemContext(), (tx) => completeJob(tx, job.id));
      log.info({ ms: Date.now() - started }, 'job succeeded');
    } catch (err) {
      const retry = !(err instanceof NonRetryableJobError);
      const outcome = await withActor(this.opts.db, systemContext(), (tx) =>
        failJob(tx, job, err, { retry }),
      );
      log.warn({ err, outcome, ms: Date.now() - started }, 'job failed');
    }
  }
}

/** Convenience for handlers: run tenant-scoped database work under the job's actor. */
export function withJobActor<T>(
  ctx: JobContext,
  fn: Parameters<typeof withActor<T>>[2],
): Promise<T> {
  return withActor(ctx.db, ctx.actor, fn);
}

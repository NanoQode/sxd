import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { checkRuntimeRole, closeDb, getDb, queueDepth } from '@simplexd/db';
import { createErrorReporter } from '@simplexd/integrations/observability';
import { createLogger } from './logger';
import { runOutboxRelay } from './outbox';
import { closeRedis } from './redis';
import { JobRunner } from './runner';
import { registerHandlers } from './handlers';
import { startScheduler } from './scheduler';

/**
 * Worker process: consumes the durable job queue, relays the transactional
 * outbox, runs scheduled maintenance (reminders, reconciliation, stale lock
 * reaping, watch-channel renewal) and exposes a small health endpoint.
 */

const log = createLogger('worker');
const workerId = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID().slice(0, 8)}`;
const appEnv = process.env.APP_ENV ?? 'development';
// Error tracking (SENTRY_DSN): sanitized job failures with job type, queue, attempt and
// correlation id; see packages/integrations/src/observability/error-reporting.ts.
const errors = createErrorReporter({
  dsn: process.env.SENTRY_DSN,
  release: process.env.APP_VERSION ?? 'dev',
  environment: appEnv,
  source: 'worker',
  onWarning: (message, detail) => log.warn(detail, message),
});

async function main(): Promise<void> {
  const db = getDb();
  const role = await checkRuntimeRole(db);
  if (!role.rlsEnforced) {
    log.warn(
      { warnings: role.warnings },
      'row-level security is not enforced for the worker database role',
    );
    if (appEnv === 'production') {
      throw new Error('refusing to start: runtime database role can bypass row-level security');
    }
  }

  const runner = new JobRunner({
    db,
    workerId,
    queues: (
      process.env.WORKER_QUEUES ?? 'default,notifications,payments,calendar,media,maintenance'
    ).split(','),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
    pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 1000),
    log,
    onJobFailed: ({ job, error, outcome }) =>
      errors.capture(error, {
        correlationId: job.correlationId,
        route: job.type,
        method: job.queue,
        level: outcome === 'dead' ? 'error' : 'warning',
        tags: { job_type: job.type, queue: job.queue, attempt: job.attempts, outcome },
      }),
  });
  registerHandlers(runner);

  const stopRelay = runOutboxRelay({
    db,
    log,
    intervalMs: Number(process.env.OUTBOX_POLL_MS ?? 750),
  });
  const stopScheduler = startScheduler({ db, log });
  runner.start();

  const port = Number(process.env.WORKER_HEALTH_PORT ?? 3100);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      try {
        const depth = await queueDepth(db);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, workerId, depth, running: runner.activeCount }));
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'unknown' }),
        );
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info({ port, workerId, queues: runner.queues }, 'worker started'));

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    server.close();
    stopRelay();
    stopScheduler();
    await runner.stop();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  log.error({ err }, 'worker failed to start');
  await errors.capture(err, { level: 'fatal', route: 'worker.start' });
  process.exit(1);
});

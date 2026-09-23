import { eq, inArray, like } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendOutbox, schema, systemContext, withActor, type OutboxRow } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { registerHandlers } from './handlers';
import { relayOutboxEvents, routeOutboxEvent, routedEventTypes, type OutboxRoute } from './outbox';
import type { JobRunner } from './runner';

/**
 * Outbox relay: business events fan out into the expected job types with
 * idempotent dedupe keys, and a failing event is counted without blocking
 * the rest of the batch.
 */

const event = (eventType: string, payload: Record<string, unknown> = {}): OutboxRow => ({
  id: 1,
  eventType,
  aggregateType: 'test',
  aggregateId: 'agg-1',
  organizationId: null,
  actorUserId: null,
  payload,
  correlationId: null,
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
});

describe('routeOutboxEvent', () => {
  it('maps business events to the job types and queues that act on them', () => {
    expect(routeOutboxEvent(event('payment.verified'))).toEqual([
      { type: 'finance.post_payment', queue: 'payments' },
      { type: 'notifications.payment_receipt', queue: 'notifications' },
    ]);
    expect(routeOutboxEvent(event('payment.event_received'))).toEqual([
      { type: 'payments.process_provider_event', queue: 'payments' },
    ]);
    expect(routeOutboxEvent(event('file.uploaded'))).toEqual([
      { type: 'media.scan_and_process', queue: 'media' },
    ]);
    expect(routeOutboxEvent(event('market_data.published'))).toEqual([
      { type: 'market_data.invalidate_caches', queue: 'default' },
    ]);
    expect(routeOutboxEvent(event('tender.closed'))).toEqual([
      { type: 'notifications.dispatch', queue: 'notifications' },
    ]);
  });

  it('carries route-specific payload (reminders nest the event payload)', () => {
    expect(routeOutboxEvent(event('appointment.reminder_due', { appointmentId: 'a1' }))).toEqual([
      {
        type: 'notifications.send_due_reminders',
        queue: 'notifications',
        payload: { reminder: { appointmentId: 'a1' } },
      },
    ]);
  });

  it('ignores unknown event types', () => {
    expect(routeOutboxEvent(event('nothing.listens'))).toEqual([]);
  });

  it('only routes to job types that have a registered handler', () => {
    const registered = new Set<string>();
    registerHandlers({
      register: (type: string) => {
        registered.add(type);
      },
    } as unknown as JobRunner);
    const missing: string[] = [];
    for (const type of routedEventTypes()) {
      for (const target of routeOutboxEvent(event(type))) {
        if (!registered.has(target.type)) missing.push(`${type} → ${target.type}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('relayOutboxEvents', () => {
  let dbs: TestDatabases;
  const run = uniqueSuffix();
  const aggregateId = `relay-${run}`;
  const queue = `oq_${run}`;
  const log = pino({ level: 'silent' });
  /** The real routes, moved onto a queue unique to this run so no other suite claims the jobs. */
  const isolated: OutboxRoute = (e) => routeOutboxEvent(e).map((t) => ({ ...t, queue }));

  async function append(eventType: string, payload: Record<string, unknown>): Promise<OutboxRow> {
    await withActor(dbs.app, systemContext(), (tx) =>
      appendOutbox(tx, {
        eventType,
        aggregateType: 'relay_test',
        aggregateId,
        payload,
        organizationId: `org_${run}`,
        actorUserId: `user_${run}`,
        correlationId: `corr-${run}-${eventType}`,
      }),
    );
    const rows = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, aggregateId));
    return rows.find((r) => r.eventType === eventType)!;
  }

  const outboxRow = async (id: number) =>
    (await dbs.owner.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, id)))[0]!;
  const jobsFor = (id: number) =>
    dbs.owner
      .select()
      .from(schema.jobs)
      .where(like(schema.jobs.dedupeKey, `outbox:${id}:%`));

  beforeAll(() => {
    dbs = connectTestDatabases();
  });

  afterAll(async () => {
    const mine = await dbs.owner
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.queue, queue));
    if (mine.length > 0)
      await dbs.owner.delete(schema.jobs).where(
        inArray(
          schema.jobs.id,
          mine.map((j) => j.id),
        ),
      );
    await dbs.owner
      .delete(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, aggregateId));
    await dbs.close();
  });

  it('enqueues one job per target with the event, identity and a dedupe key; replay is a no-op', async () => {
    const payment = await append('payment.verified', { paymentId: 'p1' });
    const lead = await append('lead.created', { leadId: 'l1' });

    const first = await withActor(dbs.app, systemContext(), (tx) =>
      relayOutboxEvents(tx, [payment, lead], log, isolated),
    );
    expect(first).toEqual({ published: [payment.id, lead.id], failed: [] });

    const paymentJobs = await jobsFor(payment.id);
    expect(paymentJobs.map((j) => j.type).sort()).toEqual([
      'finance.post_payment',
      'notifications.payment_receipt',
    ]);
    const post = paymentJobs.find((j) => j.type === 'finance.post_payment')!;
    expect(post).toMatchObject({
      dedupeKey: `outbox:${payment.id}:finance.post_payment`,
      organizationId: `org_${run}`,
      actorUserId: `user_${run}`,
      correlationId: `corr-${run}-payment.verified`,
      status: 'pending',
    });
    expect(post.payload).toEqual({
      event: {
        id: payment.id,
        type: 'payment.verified',
        aggregateType: 'relay_test',
        aggregateId,
        payload: { paymentId: 'p1' },
      },
    });
    expect((await jobsFor(lead.id)).map((j) => j.type)).toEqual(['notifications.lead_created']);
    expect((await outboxRow(payment.id)).publishedAt).toBeInstanceOf(Date);
    expect((await outboxRow(lead.id)).publishedAt).toBeInstanceOf(Date);

    // A replayed event (e.g. relay crashed after enqueueing) never duplicates a job.
    await withActor(dbs.app, systemContext(), (tx) =>
      relayOutboxEvents(tx, [payment, lead], log, isolated),
    );
    expect(await jobsFor(payment.id)).toHaveLength(2);
    expect(await jobsFor(lead.id)).toHaveLength(1);
  });

  it('marks a failing event (routing or database error) and still publishes the rest of the batch', async () => {
    const good = await append('quote.issued', { quoteId: 'q1' });
    const throws = await append('refund.approved', { refundId: 'r1' });
    const dbError = await append('invoice.issued', { invoiceId: 'i1' });
    const route: OutboxRoute = (e) => {
      if (e.id === throws.id) throw new Error('routing bug secret=s3cr3t');
      // PostgreSQL rejects \u0000 in jsonb: a database error inside the savepoint.
      if (e.id === dbError.id) return [{ type: 'broken.job', queue, payload: { bad: '\u0000' } }];
      return isolated(e);
    };
    const errors: unknown[] = [];
    const errorLog = { error: (obj: unknown) => errors.push(obj) } as unknown as Pick<
      Logger,
      'error'
    >;
    const result = await withActor(dbs.app, systemContext(), (tx) =>
      relayOutboxEvents(tx, [throws, dbError, good], errorLog, route),
    );
    expect(result).toEqual({ published: [good.id], failed: [throws.id, dbError.id] });
    expect(errors).toHaveLength(2);

    expect(await outboxRow(throws.id)).toMatchObject({
      publishedAt: null,
      attempts: 1,
      lastError: 'routing bug secret=[redacted]',
    });
    const failedDb = await outboxRow(dbError.id);
    expect(failedDb).toMatchObject({ publishedAt: null, attempts: 1 });
    expect(await jobsFor(dbError.id)).toEqual([]);
    expect((await outboxRow(good.id)).publishedAt).toBeInstanceOf(Date);
    expect((await jobsFor(good.id)).map((j) => j.type)).toEqual(['notifications.quote_issued']);
  });
});

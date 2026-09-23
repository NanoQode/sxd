import { and, eq, inArray } from 'drizzle-orm';
import { schema, systemContext, withActor } from '@simplexd/db';
import { NonRetryableJobError, type JobRunner } from '../runner';

/**
 * Tendering follow-ups enqueued in the same transaction as the business
 * change (questions.ts, awards.ts). Both handlers are idempotent: they read
 * the current record and record a notification intent per recipient; the
 * delivery adapters consume `notifications.deliver` jobs.
 */
export function registerCommercialHandlers(runner: JobRunner): void {
  runner.register('tenders.publish_answers', async ({ db, job, log }) => {
    const payload = job.payload as { tenderId?: string; questionId?: string };
    if (!payload.tenderId || !payload.questionId)
      throw new NonRetryableJobError('tenderId and questionId are required');
    const result = await withActor(
      db,
      systemContext(job.correlationId ?? undefined),
      async (tx) => {
        const [question] = await tx
          .select({
            id: schema.tenderQuestions.id,
            published: schema.tenderQuestions.published,
            answer: schema.tenderQuestions.answer,
          })
          .from(schema.tenderQuestions)
          .where(
            and(
              eq(schema.tenderQuestions.id, payload.questionId!),
              eq(schema.tenderQuestions.tenderId, payload.tenderId!),
            ),
          );
        if (!question || !question.published || !question.answer)
          return { recipients: 0, skipped: true };
        const invitees = await tx
          .select({ partnerUserId: schema.tenderInvitations.partnerUserId })
          .from(schema.tenderInvitations)
          .where(
            and(
              eq(schema.tenderInvitations.tenderId, payload.tenderId!),
              inArray(schema.tenderInvitations.status, ['invited', 'viewed', 'submitted']),
            ),
          );
        for (const invitee of invitees) {
          await tx.insert(schema.outboxEvents).values({
            eventType: 'notification.requested',
            aggregateType: 'tender_question',
            aggregateId: question.id,
            organizationId: job.organizationId,
            actorUserId: null,
            payload: {
              kind: 'tender_answer_published',
              userId: invitee.partnerUserId,
              tenderId: payload.tenderId,
              questionId: question.id,
            },
            correlationId: job.correlationId,
          });
        }
        return { recipients: invitees.length, skipped: false };
      },
    );
    log.info(result, 'tender answer publication fan-out');
  });

  runner.register('tenders.notify_award', async ({ db, job, log }) => {
    const payload = job.payload as {
      tenderId?: string;
      awardId?: string;
      recipientUserIds?: string[];
    };
    if (!payload.tenderId || !payload.awardId)
      throw new NonRetryableJobError('tenderId and awardId are required');
    const result = await withActor(
      db,
      systemContext(job.correlationId ?? undefined),
      async (tx) => {
        const [award] = await tx
          .select({
            id: schema.awards.id,
            publishedAt: schema.awards.publishedAt,
            bidId: schema.awards.bidId,
          })
          .from(schema.awards)
          .where(
            and(
              eq(schema.awards.id, payload.awardId!),
              eq(schema.awards.tenderId, payload.tenderId!),
            ),
          );
        // Partners only ever hear about a published award.
        if (!award || !award.publishedAt) return { recipients: 0, skipped: true };
        const bids = await tx
          .select({
            id: schema.bids.id,
            partnerUserId: schema.bids.partnerUserId,
            status: schema.bids.status,
          })
          .from(schema.bids)
          .where(
            and(
              eq(schema.bids.tenderId, payload.tenderId!),
              inArray(schema.bids.status, ['awarded', 'unsuccessful']),
            ),
          );
        for (const bid of bids) {
          await tx.insert(schema.outboxEvents).values({
            eventType: 'notification.requested',
            aggregateType: 'award',
            aggregateId: award.id,
            organizationId: job.organizationId,
            actorUserId: null,
            payload: {
              kind: bid.id === award.bidId ? 'tender_awarded' : 'tender_unsuccessful',
              userId: bid.partnerUserId,
              tenderId: payload.tenderId,
            },
            correlationId: job.correlationId,
          });
        }
        return { recipients: bids.length, skipped: false };
      },
    );
    log.info(result, 'award notification fan-out');
  });
}

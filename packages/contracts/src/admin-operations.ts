import { z } from 'zod';
import { reasonSchema } from './admin-market-data';
import { isoDateTimeSchema, uuidSchema } from './common';

/**
 * Admin console contracts for platform operations: the durable job queue
 * (dead-letter review and retry) and the transactional outbox (events the
 * relay stopped claiming). Job and event payloads may contain personal data
 * and are never returned; only the payload's top-level keys are shown.
 */

/** Mirrors the `job_status` database enum. */
export const jobStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const adminJobListQuerySchema = z.object({
  /** Omit to list every status, newest change first. */
  status: jobStatusSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminJobListQuery = z.infer<typeof adminJobListQuerySchema>;

export const adminJobDtoSchema = z.object({
  id: uuidSchema,
  queue: z.string(),
  type: z.string(),
  status: jobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  /** Sanitized error text of the last failure (tokens and keys redacted). */
  lastError: z.string().nullable(),
  runAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  correlationId: z.string().nullable(),
  organizationId: z.string().nullable(),
  /** Top-level payload keys only; payload values are never exposed. */
  payloadKeys: z.array(z.string()),
});
export type AdminJobDto = z.infer<typeof adminJobDtoSchema>;

export const adminJobListResponseSchema = z.object({
  items: z.array(adminJobDtoSchema),
  nextCursor: z.string().nullable(),
});
export type AdminJobListResponse = z.infer<typeof adminJobListResponseSchema>;

export const queueSummaryDtoSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  outboxUnpublished: z.number().int().nonnegative(),
  /** Unpublished events at or above the attempt threshold; the relay skips them. */
  outboxStuck: z.number().int().nonnegative(),
  outboxStuckThreshold: z.number().int().positive(),
  /** Age of the oldest job that is due and not claimed, or null when none is waiting. */
  oldestPendingSeconds: z.number().int().nonnegative().nullable(),
});
export type QueueSummaryDto = z.infer<typeof queueSummaryDtoSchema>;

/** Body for retrying a dead job or requeueing a stuck outbox event. */
export const operationsReasonSchema = z.object({ reason: reasonSchema });
export const jobRetrySchema = operationsReasonSchema;
export const outboxRequeueSchema = operationsReasonSchema;
export type OperationsReasonInput = z.infer<typeof operationsReasonSchema>;

export const stuckOutboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const stuckOutboxEventDtoSchema = z.object({
  id: z.number().int().positive(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  correlationId: z.string().nullable(),
});
export type StuckOutboxEventDto = z.infer<typeof stuckOutboxEventDtoSchema>;

export const stuckOutboxListResponseSchema = z.object({
  items: z.array(stuckOutboxEventDtoSchema),
  /** All stuck events, including those beyond `limit`. */
  total: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
});
export type StuckOutboxListResponse = z.infer<typeof stuckOutboxListResponseSchema>;

export const outboxRequeueResultSchema = z.object({
  id: z.number().int().positive(),
  attempts: z.literal(0),
  lastError: z.null(),
});
export type OutboxRequeueResult = z.infer<typeof outboxRequeueResultSchema>;

import { z } from 'zod';

/** Shared primitives and serialisation contracts for the versioned API. */

export const uuidSchema = z.uuid();
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens');
export const emailSchema = z.email().max(254);
export const phoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'E.164 phone number, e.g. +2348012345678');
/** Calendar date without time, e.g. 2026-09-22. */
export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** RFC 3339 timestamp; always UTC on the wire. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const timeZoneSchema = z.string().min(1).max(64);

/** Money on the wire: integer kobo as a decimal string plus currency. */
export const moneySchema = z.object({
  amountKobo: z.string().regex(/^-?\d+$/, 'integer kobo as a string'),
  currency: z.string().length(3).default('NGN'),
});
export type MoneyDto = z.infer<typeof moneySchema>;

/** Decimal numbers (areas, rates) travel as strings to avoid float drift. */
export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');

export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const offsetPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function sortSchema<const T extends readonly [string, ...string[]]>(fields: T) {
  return z
    .object({
      sort: z.enum(fields).optional(),
      order: z.enum(['asc', 'desc']).default('asc'),
    })
    .partial({ sort: true });
}

export const idempotencyKeyHeader = 'idempotency-key';
export const correlationIdHeader = 'x-correlation-id';

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative().optional(),
  });
}

export type Page<T> = { items: T[]; nextCursor: string | null; total?: number };

/** Standard version field for optimistic concurrency on mutations. */
export const expectedVersionSchema = z.number().int().min(1);

export const evidenceBadgeSchema = z.enum([
  'sourced_observation',
  'verified_operational_record',
  'regional_context',
  'model_estimate',
  'user_assumption',
  'unknown',
  'stale',
  'disputed',
]);
export type EvidenceBadge = z.infer<typeof evidenceBadgeSchema>;

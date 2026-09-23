import { appendOutbox, schema, type DbExecutor } from '@simplexd/db';
import { actorKindOf, isSystemActor, type FinanceActor } from './actor';

const SENSITIVE_KEYS = /password|secret|token|apikey|api_key|ciphertext|wrappeddek|refresh|authorization_code/i;

/** Strips secret-looking keys and serialises bigint kobo for audit snapshots. */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redactForAudit(v);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  actorType?: 'user' | 'system' | 'job' | 'webhook' | 'anonymous';
}

/** Appends an immutable audit entry inside the caller's transaction (any actor may append). */
export async function recordAudit(
  tx: DbExecutor,
  fa: FinanceActor,
  input: AuditInput,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorType: input.actorType ?? (isSystemActor(fa) ? 'system' : fa.actor.userId ? 'user' : 'anonymous'),
    actorUserId: fa.actor.userId,
    impersonationId: null,
    organizationId: input.organizationId ?? fa.ctx.organizationId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: input.before === undefined ? null : redactForAudit(input.before),
    after: input.after === undefined ? null : redactForAudit(input.after),
    reason: input.reason ?? null,
    ipHash: fa.ipHash ?? null,
    userAgent: fa.userAgent?.slice(0, 300) ?? null,
    correlationId: fa.correlationId ?? fa.ctx.correlationId ?? null,
  });
}

export interface DomainEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  organizationId?: string | null;
  payload: Record<string, unknown>;
}

/** Appends a transactional outbox event; bigint payload values are serialised as strings. */
export async function emitEvent(
  tx: DbExecutor,
  fa: FinanceActor,
  input: DomainEventInput,
): Promise<void> {
  await appendOutbox(tx, {
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    organizationId: input.organizationId ?? fa.ctx.organizationId ?? null,
    actorUserId: fa.actor.userId,
    payload: {
      ...(redactForAudit(input.payload) as Record<string, unknown>),
      actorKind: actorKindOf(fa),
    },
    correlationId: fa.correlationId ?? fa.ctx.correlationId ?? null,
  });
}

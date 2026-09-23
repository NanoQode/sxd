import 'server-only';
import { schema, type DbExecutor } from '@simplexd/db';
import type { RequestIdentity } from './auth/session';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  correlationId?: string | null;
  actorType?: 'user' | 'system' | 'job' | 'webhook' | 'anonymous';
}

const SENSITIVE_KEYS = /password|secret|token|apikey|api_key|ciphertext|wrappeddek|refresh/i;

/** Strips secret-looking keys from before/after snapshots. */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
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

/** Appends an immutable audit entry inside the caller's transaction. */
export async function recordAudit(tx: DbExecutor, identity: RequestIdentity | null, input: AuditInput): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorType: input.actorType ?? (identity?.session ? 'user' : 'anonymous'),
    actorUserId: identity?.session?.user.id ?? null,
    impersonationId: null,
    organizationId: input.organizationId ?? identity?.ctx.organizationId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: input.before === undefined ? null : redactForAudit(input.before),
    after: input.after === undefined ? null : redactForAudit(input.after),
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? identity?.ctx.correlationId ?? null,
  });
}

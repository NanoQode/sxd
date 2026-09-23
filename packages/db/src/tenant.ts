import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';

/**
 * Identity under which a database transaction runs. These values are exposed
 * to row-level security policies through transaction-local settings, so a
 * query that forgets an organisation filter still cannot read another
 * organisation's rows.
 */
export interface ActorContext {
  /** Authenticated user id, or null for anonymous requests. */
  userId: string | null;
  /** Active customer organisation, or null. */
  organizationId: string | null;
  /** True when the actor holds a staff role and is acting under staff policy. */
  staff: boolean;
  /** True only for system jobs that legitimately span organisations. */
  bypass?: boolean;
  /** Anonymous visitor token (cookie) that owns unsaved-to-account scenarios. */
  anonymousToken?: string | null;
  /** Correlation id for logs and audit entries. */
  correlationId?: string;
}

export const anonymousContext: ActorContext = { userId: null, organizationId: null, staff: false };

export const systemContext = (correlationId?: string): ActorContext => ({
  userId: null,
  organizationId: null,
  staff: false,
  bypass: true,
  correlationId,
});

/** Applies the actor context to the current transaction (SET LOCAL semantics). */
export async function applyActorContext(tx: Transaction, ctx: ActorContext): Promise<void> {
  await tx.execute(sql`
    SELECT
      set_config('app.user_id', ${ctx.userId ?? ''}, true),
      set_config('app.org_id', ${ctx.organizationId ?? ''}, true),
      set_config('app.staff', ${ctx.staff ? 'on' : 'off'}, true),
      set_config('app.bypass', ${ctx.bypass ? 'on' : 'off'}, true),
      set_config('app.anon_token', ${ctx.anonymousToken ?? ''}, true),
      set_config('app.correlation_id', ${ctx.correlationId ?? ''}, true)
  `);
}

/**
 * Runs `fn` inside a transaction whose row-level security context is `ctx`.
 * Every request-scoped read or write should go through this helper.
 */
export async function withActor<T>(
  db: Database,
  ctx: ActorContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyActorContext(tx, ctx);
    return fn(tx);
  });
}

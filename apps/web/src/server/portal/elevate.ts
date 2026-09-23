import 'server-only';
import { applyActorContext, type ActorContext, type Transaction } from '@simplexd/db';

/**
 * Customer transactions run under the customer's row-level security context so
 * every read proves access, and appends to the audit and outbox logs are
 * allowed for every actor (migration 0002), so nothing here is needed for
 * logging.
 *
 * The single remaining privileged case is creating a service request:
 *  - `service_requests` carries a self-referencing policy
 *    (`app.can_access_service_request(id)`) whose WITH CHECK runs before the
 *    row exists, so a customer INSERT is always refused, and
 *  - the next reference (SR-<year>-<sequence>) must be computed across all
 *    organisations, which the customer's own context cannot see.
 *
 * `elevate` is therefore called only after the application layer has
 * authorised the action and the reads under the customer's context have
 * proven access, and `demote` restores the customer's context immediately
 * after the insert so every later write is policy-checked again.
 */
export async function elevate(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: true });
}

export async function demote(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: false });
}

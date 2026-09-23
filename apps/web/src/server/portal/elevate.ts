import 'server-only';
import { applyActorContext, type ActorContext, type Transaction } from '@simplexd/db';

/**
 * Customer transactions run under the customer's row-level security context so
 * every read proves access. Some tables a customer action must write are
 * deliberately privileged-only (audit_events, outbox_events) or carry a
 * self-referencing WITH CHECK policy that cannot see the row being inserted
 * (service_requests). After the reads have proven access and the application
 * layer has authorised the action, the same transaction is elevated for the
 * remaining writes. Never call this before the access checks.
 */
export async function elevate(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: true });
}

/** Restores the customer's own context after an elevated section. */
export async function demote(tx: Transaction, ctx: ActorContext): Promise<void> {
  await applyActorContext(tx, { ...ctx, bypass: false });
}

/** Encodes a keyset cursor (timestamp + id) for stable pagination. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

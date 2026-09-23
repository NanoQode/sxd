import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ApiError, idempotencyKeyHeader } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '../auth/session';

/**
 * Idempotency keys for mutating endpoints (payments, acceptances, bookings).
 *
 * A key binds to the requester (user id or anonymous visitor token), the
 * endpoint and a hash of the request body. Re-sending the same request with
 * the same key replays the stored response; sending a different body with the
 * same key is rejected with `idempotency_conflict`; a concurrent duplicate
 * while the first request is still running gets a retryable `conflict`.
 * Only successful (2xx) responses are stored, so a failed attempt can be
 * retried with the same key.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
/** A lock older than this without completion belongs to a crashed request. */
const LOCK_STALE_MS = 2 * 60_000;

export interface IdempotencyOptions {
  /** Reject requests that omit the header (payments require it). */
  required?: boolean;
  ttlMs?: number;
}

interface StoredResponse {
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

export const idempotentReplayHeader = 'idempotent-replay';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Stable hash of endpoint + body so key reuse with a different payload is detectable. */
export function requestHash(endpoint: string, body: unknown): string {
  return createHash('sha256')
    .update(`${endpoint}\n${canonical(body)}`)
    .digest('hex');
}

/**
 * The row-level policy on idempotency_keys compares requester_id with the
 * session user id or the anonymous visitor token, so the raw value is stored.
 * User ids (32 alphanumeric characters) and visitor tokens (48 hex characters)
 * have different shapes and cannot collide.
 */
export function requesterIdFor(identity: RequestIdentity): string | null {
  if (identity.session) return identity.session.user.id;
  if (identity.ctx.anonymousToken) return identity.ctx.anonymousToken;
  return null;
}

type Claim =
  | { state: 'claimed' }
  | { state: 'busy' }
  | { state: 'mismatch' }
  | { state: 'replay'; status: number; stored: StoredResponse };

/**
 * Wraps a mutating handler with idempotency semantics. `endpoint` should be
 * the logical route (e.g. `POST /api/v1/invoices/{id}/payment-attempts`), not
 * the concrete URL, so the same key cannot be replayed across resources.
 */
export async function withIdempotency(
  req: Request,
  identity: RequestIdentity,
  endpoint: string,
  body: unknown,
  handler: () => Promise<Response>,
  options: IdempotencyOptions = {},
): Promise<Response> {
  const key = req.headers.get(idempotencyKeyHeader);
  if (!key) {
    if (options.required) {
      throw new ApiError('validation_failed', `${idempotencyKeyHeader} header is required`, {
        details: { header: idempotencyKeyHeader },
      });
    }
    return handler();
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(
      'validation_failed',
      'idempotency key must be 8-128 characters of letters, digits, "_", ".", ":" or "-"',
    );
  }
  const requesterId = requesterIdFor(identity);
  if (!requesterId) {
    throw new ApiError('validation_failed', 'idempotent requests need a session or visitor token');
  }
  const hash = requestHash(endpoint, body);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const claim = await claimKey(identity, { key, requesterId, endpoint, hash, ttlMs });

  switch (claim.state) {
    case 'mismatch':
      throw new ApiError(
        'idempotency_conflict',
        'this idempotency key was already used with a different request body',
      );
    case 'busy':
      throw new ApiError(
        'conflict',
        'a request with this idempotency key is still being processed; retry shortly',
        { retryable: true, retryAfterSeconds: 2 },
      );
    case 'replay': {
      const headers = new Headers(claim.stored.headers ?? {});
      headers.set('content-type', claim.stored.contentType);
      headers.set(idempotentReplayHeader, 'true');
      headers.set('cache-control', 'no-store');
      return new Response(claim.stored.body, { status: claim.status, headers });
    }
    case 'claimed':
      break;
  }

  let res: Response;
  try {
    res = await handler();
  } catch (err) {
    await releaseKey(identity, { key, requesterId, endpoint });
    throw err;
  }
  if (res.status >= 200 && res.status < 300) {
    const bodyText = await res.clone().text();
    const stored: StoredResponse = {
      contentType: res.headers.get('content-type') ?? 'application/json; charset=utf-8',
      body: bodyText,
    };
    const location = res.headers.get('location');
    if (location) stored.headers = { location };
    await completeKey(identity, { key, requesterId, endpoint, status: res.status, stored });
  } else {
    await releaseKey(identity, { key, requesterId, endpoint });
  }
  return res;
}

async function claimKey(
  identity: RequestIdentity,
  input: { key: string; requesterId: string; endpoint: string; hash: string; ttlMs: number },
): Promise<Claim> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const t = schema.idempotencyKeys;
  const where = and(
    eq(t.requesterId, input.requesterId),
    eq(t.endpoint, input.endpoint),
    eq(t.key, input.key),
  );
  return withActor(getDb(), identity.ctx, async (tx) => {
    const inserted = await tx
      .insert(t)
      .values({
        key: input.key,
        requesterId: input.requesterId,
        endpoint: input.endpoint,
        requestHash: input.hash,
        lockedAt: now,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ key: t.key });
    if (inserted.length > 0) return { state: 'claimed' };

    const [existing] = await tx.select().from(t).where(where).for('update');
    if (!existing) return { state: 'busy' };

    if (existing.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(t)
        .set({
          requestHash: input.hash,
          lockedAt: now,
          completedAt: null,
          responseStatus: null,
          responseBody: null,
          expiresAt,
        })
        .where(where);
      return { state: 'claimed' };
    }
    if (existing.requestHash !== input.hash) return { state: 'mismatch' };
    if (existing.completedAt && existing.responseStatus && existing.responseBody) {
      return {
        state: 'replay',
        status: existing.responseStatus,
        stored: existing.responseBody as StoredResponse,
      };
    }
    const lockedAt = existing.lockedAt?.getTime() ?? 0;
    if (now.getTime() - lockedAt > LOCK_STALE_MS) {
      await tx.update(t).set({ lockedAt: now }).where(where);
      return { state: 'claimed' };
    }
    return { state: 'busy' };
  });
}

async function completeKey(
  identity: RequestIdentity,
  input: {
    key: string;
    requesterId: string;
    endpoint: string;
    status: number;
    stored: StoredResponse;
  },
): Promise<void> {
  const t = schema.idempotencyKeys;
  await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .update(t)
      .set({ completedAt: new Date(), responseStatus: input.status, responseBody: input.stored })
      .where(
        and(
          eq(t.requesterId, input.requesterId),
          eq(t.endpoint, input.endpoint),
          eq(t.key, input.key),
        ),
      ),
  );
}

async function releaseKey(
  identity: RequestIdentity,
  input: { key: string; requesterId: string; endpoint: string },
): Promise<void> {
  const t = schema.idempotencyKeys;
  try {
    await withActor(getDb(), identity.ctx, (tx) =>
      tx
        .delete(t)
        .where(
          and(
            eq(t.requesterId, input.requesterId),
            eq(t.endpoint, input.endpoint),
            eq(t.key, input.key),
          ),
        ),
    );
  } catch {
    // The stale-lock rule lets a later retry reclaim the key.
  }
}

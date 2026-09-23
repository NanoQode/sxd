import 'server-only';
import { randomUUID } from 'node:crypto';
import { unstable_rethrow } from 'next/navigation';
import { ApiError } from '@simplexd/contracts';
import { AuthorizationError } from '@simplexd/domain/authz';
import { logger } from '@/lib/logger';

/**
 * Page-level loading for tenant screens. A failed read never throws the page
 * away: it becomes an honest error state carrying a correlation id that is
 * also written to the server log, so support can find the failure.
 */

export interface LoadFailure {
  code: string;
  message: string;
  correlationId: string;
}

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: LoadFailure };

export function describeFailure(err: unknown, what: string): LoadFailure {
  const correlationId = `page-${randomUUID()}`;
  if (err instanceof ApiError) {
    if (err.status >= 500) logger().error({ correlationId, what, err }, 'tenant page load failed');
    else logger().warn({ correlationId, what, code: err.code }, 'tenant page load refused');
    return { code: err.code, message: err.message, correlationId };
  }
  if (err instanceof AuthorizationError) {
    logger().warn({ correlationId, what, code: err.decision.code }, 'tenant page load refused');
    return { code: 'forbidden', message: err.decision.reason, correlationId };
  }
  logger().error({ correlationId, what, err }, 'tenant page load failed');
  return {
    code: 'internal_error',
    message: `We could not load ${what}. Nothing is shown in its place rather than guessing.`,
    correlationId,
  };
}

export async function safeLoad<T>(what: string, fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: describeFailure(err, what) };
  }
}

/** True when a load failed only because the record is not the caller's (or does not exist). */
export function isNotFound(result: Loaded<unknown>): boolean {
  return !result.ok && (result.error.code === 'not_found' || result.error.code === 'forbidden');
}

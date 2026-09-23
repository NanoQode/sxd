'use client';

import { describeError, type DescribedError } from '@/lib/portal/client';

export { newIdempotencyKey, portalFetch as tenantFetch } from '@/lib/portal/client';

/**
 * Customer-safe description of a failed tenant mutation. A request that
 * never reached the server (offline, dropped connection) says so and that
 * nothing was saved, so the person keeps their input and retries.
 */
export function describeTenantError(err: unknown, fallback?: string): DescribedError {
  if (err instanceof TypeError && typeof navigator !== 'undefined' && !navigator.onLine) {
    return {
      message:
        'You appear to be offline. Nothing was sent; your input is kept here, try again when you are connected.',
      code: 'offline',
      correlationId: null,
      status: null,
    };
  }
  if (err instanceof TypeError) {
    return {
      message: 'The request did not reach SimplexD (network error). Nothing was saved; try again.',
      code: 'network',
      correlationId: null,
      status: null,
    };
  }
  return describeError(err, fallback);
}

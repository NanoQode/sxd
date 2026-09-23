import { authorizeStaff } from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Visibility rules for the market read model.
 *
 * Anonymous visitors and customers only ever see published markets and the
 * observations whose current interpretation is published. Staff holding
 * `market_data.read_drafts` may look at drafts, in-review rows and
 * unpublished rows, each carrying its own state so nothing is mistaken for a
 * published value.
 */
export interface Visibility {
  /** True when the caller may read unpublished markets, observations and quotes. */
  readDrafts: boolean;
  /** True when the caller asked for unpublished markets and is allowed to. */
  includeUnpublished: boolean;
}

export function canReadDrafts(identity: RequestIdentity): boolean {
  return authorizeStaff(identity.actor, 'market_data.read_drafts').allowed;
}

export function visibilityFor(identity: RequestIdentity, includeUnpublished = false): Visibility {
  const readDrafts = canReadDrafts(identity);
  return { readDrafts, includeUnpublished: readDrafts && includeUnpublished };
}

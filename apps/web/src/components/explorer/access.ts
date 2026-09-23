import 'server-only';
import type { AccountAccess } from '@/lib/explorer';
import type { RequestIdentity } from '@/lib/auth/session';
import { ANONYMOUS_SCENARIOS_FLAG } from '@/server/markets/scenarios';

/** What the explorer needs to know about the visitor, from the request identity (server pages only). */
export function explorerAccessFor(identity: RequestIdentity): AccountAccess {
  return {
    signedIn: identity.session !== null,
    anonymousSavesAllowed: identity.featureFlags[ANONYMOUS_SCENARIOS_FLAG] === true,
  };
}

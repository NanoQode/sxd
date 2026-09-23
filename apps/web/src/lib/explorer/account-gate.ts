import type { ResumeIntent } from './resume-intents';
import { serializeExplorer, type ExplorerParams } from './url-state';

/**
 * Account gate for the explorer (brief §5): exploring the map, filtering,
 * comparing and calculator estimates never need an account. Saving a plan,
 * sharing it privately, requesting local verification, starting a service and
 * generating a dated report do, unless administrators switched
 * `core.anonymous_scenarios` on (server-side anonymous saves). A gated action
 * sends the visitor to sign-in with the complete explorer URL in `next` and
 * the chosen action in `resume`, so nothing has to be repeated afterwards.
 *
 * Pure decisions live here so they can be unit-tested; the side effects
 * (storing the draft, navigating) are in the explorer context. The
 * dependency-free pieces the sign-in pages need are in `resume-intents.ts`.
 */

export type GatedAction = ResumeIntent;

export interface AccountAccess {
  /** True when the server rendered the explorer for a signed-in user. */
  signedIn: boolean;
  /** `core.anonymous_scenarios`: administrators may allow server-side saves without an account. */
  anonymousSavesAllowed: boolean;
}

export const ANONYMOUS_ACCESS: AccountAccess = { signedIn: false, anonymousSavesAllowed: false };

export type GateDecision = { kind: 'proceed' } | { kind: 'sign_in'; action: GatedAction };

/** Decides whether an action may proceed for the visitor or needs an account first. */
export function decideScenarioAction(action: GatedAction, access: AccountAccess): GateDecision {
  if (access.signedIn) return { kind: 'proceed' };
  // Private share links always belong to an account: the server refuses anonymous sharing.
  if (action === 'share') return { kind: 'sign_in', action };
  if (access.anonymousSavesAllowed) return { kind: 'proceed' };
  return { kind: 'sign_in', action };
}

/** The explorer URL the visitor comes back to after signing in, carrying every param plus the action. */
export function buildResumeHref(
  params: Partial<ExplorerParams>,
  action: GatedAction,
  path: '/explore' | '/' = '/explore',
): string {
  return serializeExplorer(path, { ...params, resume: action });
}

/** Sign-in URL whose `next` is the explorer state (a same-origin path, as the sign-in page requires). */
export function buildSignInHref(nextHref: string, page: 'sign-in' | 'sign-up' = 'sign-in'): string {
  return `/${page}?next=${encodeURIComponent(nextHref)}`;
}

import {
  RESUME_INTENTS,
  serializeExplorer,
  type ExplorerParams,
  type ResumeIntent,
} from './url-state';

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
 * (storing the draft, navigating) are in the explorer context.
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

export const ACTION_LABELS: Record<GatedAction, string> = {
  save: 'save this scenario',
  share: 'share this scenario privately',
  verify: 'request local verification',
  service: 'start a service from this scenario',
  report: 'generate a dated comparison report',
};

/** Decides whether an action may proceed for the visitor or needs an account first. */
export function decideScenarioAction(action: GatedAction, access: AccountAccess): GateDecision {
  if (access.signedIn) return { kind: 'proceed' };
  // Private share links always belong to an account: the server refuses anonymous sharing.
  if (action === 'share') return { kind: 'sign_in', action };
  if (access.anonymousSavesAllowed) return { kind: 'proceed' };
  return { kind: 'sign_in', action };
}

export function isResumeIntent(value: string | null | undefined): value is ResumeIntent {
  return value !== undefined && value !== null && (RESUME_INTENTS as readonly string[]).includes(value);
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

/** The action encoded in a `next` path, when it points at the explorer with a resume intent. */
export function resumeIntentFromNext(next: string | null | undefined): ResumeIntent | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  const queryStart = next.indexOf('?');
  if (queryStart === -1) return null;
  const path = next.slice(0, queryStart);
  if (path !== '/explore' && path !== '/') return null;
  const value = new URLSearchParams(next.slice(queryStart + 1)).get('resume');
  return isResumeIntent(value) ? value : null;
}

/** Wording for the sign-in/sign-up pages when the visitor arrives from a gated explorer action. */
export function resumeMessage(intent: ResumeIntent): string {
  const continuation: Record<ResumeIntent, string> = {
    save: 'the save dialog opens again, pre-filled, so one click finishes it',
    share: 'the scenario is saved and the private share link is created',
    verify: 'the verification request form opens again',
    service: 'the scenario is saved and you continue to the booking form',
    report: 'the comparison opens again so you can generate the dated report',
  };
  return `Sign in to ${ACTION_LABELS[intent]}. Your filters, compared markets, priorities and assumptions are kept; after sign-in ${continuation[intent]}.`;
}

/**
 * Account-gated explorer actions a visitor can resume after signing in
 * (brief §5). This module has no dependencies so server components (the
 * sign-in and sign-up pages) can read the intent from a `next` path without
 * pulling in the client-only URL parsers.
 */

export const RESUME_INTENTS = ['save', 'share', 'verify', 'service', 'report'] as const;
export type ResumeIntent = (typeof RESUME_INTENTS)[number];

export const ACTION_LABELS: Record<ResumeIntent, string> = {
  save: 'save this scenario',
  share: 'share this scenario privately',
  verify: 'request local verification',
  service: 'start a service from this scenario',
  report: 'generate a dated comparison report',
};

export function isResumeIntent(value: string | null | undefined): value is ResumeIntent {
  return (
    value !== undefined && value !== null && (RESUME_INTENTS as readonly string[]).includes(value)
  );
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

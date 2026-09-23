/**
 * Pure helpers for price anchor revisions (no I/O). The admin pricing module
 * writes `service_package_revisions.snapshot` in the shape below; the public
 * catalogue uses `effectiveAnchor` to pick the published values in force on a
 * given day, so a change published with a future effective date never shows
 * before that date, and proposals (draft or in review) are never read.
 */

export type PriceBasis = 'fixed' | 'from' | 'per_month' | 'percentage' | 'quotation';
export type PackagePublication = 'draft' | 'in_review' | 'published' | 'retired';

export type RevisionEvent =
  'draft_saved' | 'submitted' | 'published' | 'rejected' | 'withdrawn' | 'retired';
export type RevisionState =
  'draft' | 'in_review' | 'published' | 'rejected' | 'withdrawn' | 'retired';

export const STATE_FOR_EVENT: Record<RevisionEvent, RevisionState> = {
  draft_saved: 'draft',
  submitted: 'in_review',
  published: 'published',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  retired: 'retired',
};

export interface AnchorValues {
  name: string;
  description: string | null;
  scopeMarkdown: string | null;
  priceBasis: PriceBasis;
  /** Integer kobo as a decimal string. */
  amountKobo: string | null;
  /** Basis points (150 = 1.5%). */
  percentageBps: number | null;
  currency: string;
  minimumScope: string | null;
  exclusions: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** Shape stored in `service_package_revisions.snapshot`. */
export interface AnchorSnapshot {
  kind: 'price_anchor';
  event: RevisionEvent;
  state: RevisionState;
  values: AnchorValues;
}

const EVENTS = new Set<string>(Object.keys(STATE_FOR_EVENT));

/** Parses a stored snapshot; anything not written by the pricing module is ignored, never trusted. */
export function parseAnchorSnapshot(raw: unknown): AnchorSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AnchorSnapshot>;
  if (s.kind !== 'price_anchor' || typeof s.event !== 'string' || !EVENTS.has(s.event)) return null;
  const v = s.values as Partial<AnchorValues> | undefined;
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.priceBasis !== 'string')
    return null;
  const event = s.event as RevisionEvent;
  return {
    kind: 'price_anchor',
    event,
    state: STATE_FOR_EVENT[event],
    values: {
      name: v.name,
      description: v.description ?? null,
      scopeMarkdown: v.scopeMarkdown ?? null,
      priceBasis: v.priceBasis as PriceBasis,
      amountKobo: typeof v.amountKobo === 'string' ? v.amountKobo : null,
      percentageBps: typeof v.percentageBps === 'number' ? v.percentageBps : null,
      currency: v.currency ?? 'NGN',
      minimumScope: v.minimumScope ?? null,
      exclusions: v.exclusions ?? null,
      effectiveFrom: v.effectiveFrom ?? null,
      effectiveTo: v.effectiveTo ?? null,
    },
  };
}

export interface EffectiveAnchor {
  /** Values to show publicly; null when nothing may be shown. */
  values: AnchorValues | null;
  /** Publication state the public label should use. */
  state: PackagePublication;
  /** Date a published change takes effect when it is not yet in force. */
  upcomingFrom: string | null;
}

/**
 * Picks what the public may see for one package on `today` (YYYY-MM-DD):
 * - published and in force → the live row;
 * - published with a future effective date → the latest earlier published
 *   revision already in force, or nothing (with the upcoming date) when the
 *   anchor has never been in force;
 * - in review → no values (the label says it is under review);
 * - draft or retired → nothing.
 * `publishedRevisions` are the package's `published` revision snapshots.
 */
export function effectiveAnchor(
  live: AnchorValues,
  state: PackagePublication,
  publishedRevisions: AnchorValues[],
  today: string,
): EffectiveAnchor {
  if (state !== 'published') return { values: null, state, upcomingFrom: null };
  if (!live.effectiveFrom || live.effectiveFrom <= today)
    return { values: live, state: 'published', upcomingFrom: null };
  const prior = publishedRevisions
    .filter((r) => r.effectiveFrom !== null && r.effectiveFrom <= today)
    .at(-1);
  return {
    values: prior ?? null,
    state: 'published',
    upcomingFrom: live.effectiveFrom,
  };
}

/** Today's date in the business time zone (Africa/Lagos) as YYYY-MM-DD. */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

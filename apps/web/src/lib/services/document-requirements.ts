/**
 * Pure helpers deciding which documents a customer is asked for (no I/O).
 * A requirement applies to one service or, with no service, to every
 * service; its `stage` is the engagement stage from which the document is
 * needed (null means from intake). Sensitive documents (identity papers)
 * are only requested when the transaction needs them, so the public site
 * never lists them and the portal explains why they are asked for.
 */

export type EngagementStage =
  | 'inquiry'
  | 'triage'
  | 'quoted'
  | 'accepted'
  | 'awaiting_payment'
  | 'in_progress'
  | 'in_review'
  | 'delivered'
  | 'completed'
  | 'rejected'
  | 'paused'
  | 'cancelled';

/** Forward order of the shared engagement pipeline (brief §8). */
export const STAGE_ORDER: readonly EngagementStage[] = [
  'inquiry',
  'triage',
  'quoted',
  'accepted',
  'awaiting_payment',
  'in_progress',
  'in_review',
  'delivered',
  'completed',
];

const CLOSED: ReadonlySet<EngagementStage> = new Set(['completed', 'rejected', 'cancelled']);

export const SENSITIVE_DOCUMENT_NOTE =
  'Identity documents are collected only when the transaction requires them, and only the people working on your request can open them.';

export interface RequirementLike {
  id: string;
  serviceId: string | null;
  name: string;
  description: string | null;
  stage: EngagementStage | null;
  required: boolean;
  sensitive: boolean;
  active: boolean;
  sortOrder: number;
}

export function stageRank(stage: EngagementStage | null): number {
  if (stage === null) return 0;
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? STAGE_ORDER.length : i;
}

/**
 * The pipeline stage whose document list applies to a request: its status,
 * or the stage it was paused from; null once the request is closed.
 */
export function documentStage(
  status: EngagementStage,
  transitions: Array<{ fromStatus: string | null; toStatus: string; createdAt: string }> = [],
): EngagementStage | null {
  if (CLOSED.has(status)) return null;
  if (status !== 'paused') return status;
  const pause = [...transitions]
    .filter((t) => t.toStatus === 'paused' && t.fromStatus)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const from = pause?.fromStatus as EngagementStage | undefined;
  return from && STAGE_ORDER.includes(from) ? from : 'inquiry';
}

export function appliesToService(r: RequirementLike, serviceId: string): boolean {
  return r.active && (r.serviceId === null || r.serviceId === serviceId);
}

function byStageThenOrder(a: RequirementLike, b: RequirementLike): number {
  return (
    stageRank(a.stage) - stageRank(b.stage) ||
    a.sortOrder - b.sortOrder ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Splits the requirements that apply to a service into those needed by the
 * given stage and those needed later. `includeSensitive` is false for public
 * pages.
 */
export function requirementsForStage<T extends RequirementLike>(
  requirements: T[],
  input: { serviceId: string; stage: EngagementStage | null; includeSensitive: boolean },
): { now: T[]; later: T[] } {
  const applicable = requirements
    .filter((r) => appliesToService(r, input.serviceId))
    .filter((r) => input.includeSensitive || !r.sensitive)
    .sort(byStageThenOrder);
  if (input.stage === null) return { now: [], later: [] };
  const current = stageRank(input.stage);
  return {
    now: applicable.filter((r) => stageRank(r.stage) <= current),
    later: applicable.filter((r) => stageRank(r.stage) > current),
  };
}

/** Public "What you'll need" list: active, non-sensitive requirements for a service. */
export function publicRequirements<T extends RequirementLike>(requirements: T[], serviceId: string): T[] {
  return requirements
    .filter((r) => appliesToService(r, serviceId) && !r.sensitive)
    .sort(byStageThenOrder);
}

export function stageLabel(stage: EngagementStage | null): string {
  if (stage === null) return 'At intake';
  const labels: Record<EngagementStage, string> = {
    inquiry: 'At intake',
    triage: 'During triage',
    quoted: 'With the quotation',
    accepted: 'After you accept',
    awaiting_payment: 'Before payment',
    in_progress: 'Once work starts',
    in_review: 'During review',
    delivered: 'At delivery',
    completed: 'At completion',
    rejected: 'Declined',
    paused: 'While paused',
    cancelled: 'Cancelled',
  };
  return labels[stage];
}

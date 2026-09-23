'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ComparableSummary } from '@simplexd/contracts';
import { Alert, Button, Field, Input, Textarea, useToast } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../_components/action-dialog';

type Decision =
  | 'approve'
  | 'reject'
  | 'dispute'
  | 'mark_stale'
  | 'publish'
  | 'unpublish'
  | 'mark_rank_eligible'
  | 'mark_rank_ineligible';

export interface ReviewTarget {
  id: string;
  metric: string;
  statistic: string;
  geographyLevel: string;
  interpretation: {
    version: number;
    reviewStatus: string;
    publicationState: string;
    rankEligible: boolean;
    createdBy: string | null;
  };
  createdBy: string | null;
}

interface DecisionMeta {
  label: string;
  title: string;
  description: string;
  tone: 'primary' | 'danger';
  requireNote: boolean;
  permission: 'publish' | 'edit';
}

const META: Record<Decision, DecisionMeta> = {
  approve: {
    label: 'Approve',
    title: 'Approve (mark verified)',
    description: 'Business review passed. Publication is a separate step.',
    tone: 'primary',
    requireNote: false,
    permission: 'publish',
  },
  reject: {
    label: 'Reject',
    title: 'Reject observation',
    description: 'The observation stays inspectable but is excluded from panels and ranking.',
    tone: 'danger',
    requireNote: true,
    permission: 'publish',
  },
  dispute: {
    label: 'Dispute',
    title: 'Raise a dispute',
    description: 'Marks the evidence as challenged; it is excluded from ranking until resolved.',
    tone: 'danger',
    requireNote: true,
    permission: 'edit',
  },
  mark_stale: {
    label: 'Mark stale',
    title: 'Mark as stale',
    description: 'Stale evidence remains inspectable but is excluded from default ranking.',
    tone: 'primary',
    requireNote: false,
    permission: 'edit',
  },
  publish: {
    label: 'Publish',
    title: 'Publish to the public evidence panel',
    description:
      'Requires the approver permission and a different person from the submitter. Local medians need enough deduplicated comparables.',
    tone: 'primary',
    requireNote: false,
    permission: 'publish',
  },
  unpublish: {
    label: 'Unpublish',
    title: 'Unpublish',
    description: 'Removes it from public panels; history is kept.',
    tone: 'danger',
    requireNote: true,
    permission: 'publish',
  },
  mark_rank_eligible: {
    label: 'Mark rank-eligible',
    title: 'Mark as rank-eligible',
    description:
      'Allows the ranking engine to use this published, verified, local observation. Give the evidence basis.',
    tone: 'primary',
    requireNote: true,
    permission: 'publish',
  },
  mark_rank_ineligible: {
    label: 'Mark rank-ineligible',
    title: 'Exclude from ranking',
    description: 'Records why this observation must not feed the ranking.',
    tone: 'primary',
    requireNote: true,
    permission: 'edit',
  },
};

function available(t: ReviewTarget): Decision[] {
  const i = t.interpretation;
  const out: Decision[] = [];
  const pending = i.reviewStatus === 'source_read_pending_business_review';
  if (pending || i.reviewStatus === 'disputed' || i.reviewStatus === 'stale') out.push('approve');
  if (i.reviewStatus !== 'rejected') out.push('reject');
  if (i.reviewStatus !== 'disputed' && i.reviewStatus !== 'rejected') out.push('dispute');
  if (i.reviewStatus !== 'stale' && i.reviewStatus !== 'rejected') out.push('mark_stale');
  if (i.publicationState !== 'published' && (pending || i.reviewStatus === 'verified'))
    out.push('publish');
  if (i.publicationState === 'published') out.push('unpublish');
  if (i.publicationState === 'published' && i.reviewStatus === 'verified' && !i.rankEligible)
    out.push('mark_rank_eligible');
  if (i.rankEligible) out.push('mark_rank_ineligible');
  return out;
}

/**
 * Review decision buttons for an observation. The server enforces every rule;
 * the UI hides decisions the actor cannot take and explains the evidence gate
 * for local medians (comparables) before publication.
 */
export function ReviewActions({
  target,
  actorId,
  canPublish,
  canEdit,
  comparables,
  compact = false,
  onDone,
}: {
  target: ReviewTarget;
  actorId: string;
  canPublish: boolean;
  canEdit: boolean;
  comparables?: ComparableSummary | null;
  compact?: boolean;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [reasonNotRankEligible, setReasonNotRankEligible] = useState('');
  const [contextual, setContextual] = useState(false);
  const [comp, setComp] = useState<ComparableSummary | null | undefined>(comparables);
  const [loadingComp, setLoadingComp] = useState(false);

  const ownWork = (target.createdBy ?? target.interpretation.createdBy) === actorId;
  const decisions = available(target).filter((d) => {
    const meta = META[d];
    if (meta.permission === 'publish' && !canPublish) return false;
    if (meta.permission === 'edit' && !canEdit && !canPublish) return false;
    return true;
  });

  function openDecision(d: Decision) {
    setNote('');
    setReasonNotRankEligible('');
    setContextual(false);
    setDecision(d);
    if ((d === 'publish' || d === 'mark_rank_eligible') && comp === undefined) {
      setLoadingComp(true);
      apiFetch<{ comparables: ComparableSummary }>(`/api/v1/admin/observations/${target.id}`)
        .then((res) => setComp(res.comparables))
        .catch(() => setComp(null))
        .finally(() => setLoadingComp(false));
    }
  }

  async function submit(decisionToApply: Decision) {
    try {
      await apiFetch(`/api/v1/admin/observations/${target.id}/review`, {
        method: 'POST',
        body: {
          decision: decisionToApply,
          note: note.trim() || undefined,
          reasonNotRankEligible: reasonNotRankEligible.trim() || undefined,
          publishAsContextual: contextual,
          expectedVersion: target.interpretation.version,
        },
      });
      toast({ title: `${META[decisionToApply].label}: done`, tone: 'success' });
      onDone?.();
      router.refresh();
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  }

  if (decisions.length === 0)
    return <span className="text-xs text-fg-subtle">No actions available</span>;

  const meta = decision ? META[decision] : null;
  const showComparables = decision === 'publish' || decision === 'mark_rank_eligible';
  const blockedByComparables = Boolean(showComparables && comp?.applicable && !comp.satisfied);
  const sodBlocked = Boolean(
    meta &&
    (decision === 'approve' || decision === 'publish' || decision === 'mark_rank_eligible') &&
    ownWork,
  );

  return (
    <>
      <div className={compact ? 'flex flex-wrap gap-1' : 'flex flex-wrap gap-2'}>
        {decisions.map((d) => (
          <Button
            key={d}
            size="sm"
            variant={
              META[d].tone === 'danger'
                ? 'secondary'
                : d === 'publish' || d === 'approve'
                  ? 'primary'
                  : 'secondary'
            }
            onClick={() => openDecision(d)}
          >
            {META[d].label}
          </Button>
        ))}
      </div>
      <ActionDialog
        open={decision !== null}
        onOpenChange={(o) => !o && setDecision(null)}
        title={meta?.title ?? ''}
        description={meta?.description}
        confirmLabel={meta?.label ?? 'Confirm'}
        tone={meta?.tone ?? 'primary'}
        onConfirm={async () => {
          if (!decision) return;
          if (meta?.requireNote && note.trim().length < 3)
            throw new Error('A note of at least 3 characters is required.');
          if (decision === 'mark_rank_ineligible' && reasonNotRankEligible.trim().length < 3)
            throw new Error('Give the reason the observation is not rank-eligible.');
          if (decision === 'publish' && blockedByComparables && !contextual)
            throw new Error('Publish as contextual evidence or collect more comparables first.');
          await submit(decision);
        }}
      >
        {sodBlocked ? (
          <Alert tone="warning" title="Separation of duties">
            You submitted this interpretation. Another data approver must{' '}
            {decision === 'approve' ? 'approve' : decision === 'publish' ? 'publish' : 'mark'} it;
            the server will refuse this action (own_work).
          </Alert>
        ) : null}
        {showComparables ? (
          <div className="rounded-md border border-border bg-bg-sunken p-3 text-sm">
            <p className="font-medium">Comparables check</p>
            {loadingComp ? (
              <p className="text-fg-muted">Counting deduplicated comparables…</p>
            ) : null}
            {comp === null ? (
              <p className="text-fg-muted">Could not load the comparables summary.</p>
            ) : null}
            {comp && !comp.applicable ? (
              <p className="text-fg-muted">
                Not a local median ({target.statistic}, {target.geographyLevel.replace(/_/g, ' ')});
                the publication threshold does not apply.
              </p>
            ) : null}
            {comp?.applicable ? (
              <ul className="mt-1 space-y-0.5 text-fg-muted">
                <li>
                  Deduplicated local comparables for this metric and cohort:{' '}
                  <strong className="text-fg">{comp.count}</strong> of{' '}
                  <strong className="text-fg">{comp.minComparables}</strong> required
                </li>
                <li>
                  Source concentration:{' '}
                  {comp.sourceConcentration === null
                    ? '—'
                    : `${Math.round(comp.sourceConcentration * 100)}%`}
                  {comp.largestSourceTitle ? ` (${comp.largestSourceTitle})` : ''}
                </li>
              </ul>
            ) : null}
            {decision === 'publish' && blockedByComparables ? (
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--sx-primary)]"
                  checked={contextual}
                  onChange={(e) => setContextual(e.target.checked)}
                />
                <span>
                  Publish as contextual evidence (not a local median). It will never be
                  rank-eligible and the reason is recorded on the interpretation.
                </span>
              </label>
            ) : null}
            {decision === 'mark_rank_eligible' && blockedByComparables ? (
              <p className="mt-2 text-danger">
                Below the comparables threshold; collect more comparables before marking
                rank-eligible.
              </p>
            ) : null}
          </div>
        ) : null}
        {decision === 'mark_rank_ineligible' ? (
          <Field label="Reason not rank-eligible" required>
            {({ id }) => (
              <Input
                id={id}
                value={reasonNotRankEligible}
                onChange={(e) => setReasonNotRankEligible(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        <Field
          label={meta?.requireNote ? 'Note (required)' : 'Note (optional)'}
          required={meta?.requireNote}
        >
          {({ id }) => (
            <Textarea
              id={id}
              className="min-h-20"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </ActionDialog>
    </>
  );
}

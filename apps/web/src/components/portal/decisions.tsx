'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

type Decision = 'approved' | 'rejected' | 'accepted';

interface Target {
  /** Dialog title, e.g. "Change order #3: Extra drainage". */
  label: string;
  /** What approving means, in plain words. */
  effect: string;
  approveLabel: string;
  rejectLabel: string;
  approveValue: Decision;
  rejectValue: Decision;
  /** Builds the request for a decision. */
  request: (decision: Decision, note: string) => { path: string; body: Record<string, unknown> };
  successTitle: string;
}

/**
 * Shared approve/reject dialog for change orders, milestone acceptance and
 * budget versions. Rejections always carry a note; the server re-checks the
 * role and the optimistic version before recording anything.
 */
function DecisionDialog({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  function reset() {
    setDecision(null);
    setNote('');
    setError(null);
    onClose();
  }

  async function submit(chosen: Decision) {
    if (!target) return;
    const rejecting = chosen === target.rejectValue;
    if (rejecting && note.trim().length < 3) {
      setDecision(chosen);
      setError({ message: 'A short reason is required to reject.', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { path, body } = target.request(chosen, note.trim());
      await portalFetch(path, { body });
      toast({ title: target.successTitle, tone: 'success' });
      reset();
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && reset()}>
      {target ? (
        <DialogContent title={target.label} description={target.effect}>
          <div className="space-y-4">
            {error ? (
              <ErrorState
                title="Decision not recorded"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field
              label={
                decision === target.rejectValue
                  ? 'Reason for rejecting'
                  : 'Note (required when rejecting)'
              }
              required={decision === target.rejectValue}
              hint="Recorded with your decision and shared with the team."
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={3}
                  maxLength={4000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                Decide later
              </Button>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void submit(target.rejectValue)}
                  loading={busy && decision === target.rejectValue}
                >
                  {target.rejectLabel}
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setDecision(target.approveValue);
                    void submit(target.approveValue);
                  }}
                  loading={busy && decision !== target.rejectValue}
                >
                  {target.approveLabel}
                </Button>
              </div>
            </DialogFooter>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function ChangeOrderDecision({
  changeOrder,
  canDecide,
  cannotDecideReason,
  amountLabel,
}: {
  changeOrder: {
    id: string;
    number: number;
    title: string;
    version: number;
    scheduleDeltaDays: number;
  };
  canDecide: boolean;
  cannotDecideReason?: string;
  amountLabel: string;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  if (!canDecide) {
    return (
      <p className="text-sm text-fg-muted">
        {cannotDecideReason ??
          'Deciding change orders needs an owner or approver of this organisation.'}
      </p>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          setTarget({
            label: `Change order #${changeOrder.number}: ${changeOrder.title}`,
            effect: `Approving adjusts the approved budget by ${amountLabel}${changeOrder.scheduleDeltaDays ? ` and the schedule by ${changeOrder.scheduleDeltaDays} day(s)` : ''} once every required approval exists. Rejecting closes it with your reason.`,
            approveLabel: 'Approve change order',
            rejectLabel: 'Reject',
            approveValue: 'approved',
            rejectValue: 'rejected',
            successTitle: 'Decision recorded',
            request: (decision, note) => ({
              path: `/api/v1/change-orders/${changeOrder.id}/approve`,
              body: {
                approverRole: 'customer',
                decision,
                ...(note ? { note } : {}),
                expectedVersion: changeOrder.version,
              },
            }),
          })
        }
      >
        Decide
      </Button>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export function MilestoneDecision({
  milestone,
  canDecide,
  cannotDecideReason,
}: {
  milestone: { id: string; name: string; inspectorProgressPct: number | null };
  canDecide: boolean;
  cannotDecideReason?: string;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  if (!canDecide) {
    return (
      <p className="text-sm text-fg-muted">
        {cannotDecideReason ??
          'Accepting milestones needs an owner or approver of this organisation.'}
      </p>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          setTarget({
            label: `Milestone: ${milestone.name}`,
            effect: `The team presented this milestone as complete${milestone.inspectorProgressPct !== null ? ` (inspector estimate ${milestone.inspectorProgressPct}%, which is not an acceptance)` : ''}. Accepting lets finance authorise the related payment; rejecting sends it back for rework with your reason.`,
            approveLabel: 'Accept milestone',
            rejectLabel: 'Reject',
            approveValue: 'accepted',
            rejectValue: 'rejected',
            successTitle: 'Milestone decision recorded',
            request: (decision, note) => ({
              path: `/api/v1/milestones/${milestone.id}/acceptance`,
              body: { decision, ...(note ? { reason: note } : {}) },
            }),
          })
        }
      >
        Decide
      </Button>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export function BudgetDecision({
  budget,
  canDecide,
  cannotDecideReason,
  totalLabel,
}: {
  budget: { id: string; version: number };
  canDecide: boolean;
  cannotDecideReason?: string;
  totalLabel: string;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  if (!canDecide) {
    return (
      <p className="text-sm text-fg-muted">
        {cannotDecideReason ?? 'Approving budgets needs an owner or approver of this organisation.'}
      </p>
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          setTarget({
            label: `Budget version ${budget.version}`,
            effect: `Approving makes ${totalLabel} the approved budget once staff approval also exists; commitments and actuals are then measured against it.`,
            approveLabel: 'Approve budget',
            rejectLabel: 'Reject',
            approveValue: 'approved',
            rejectValue: 'rejected',
            successTitle: 'Budget decision recorded',
            request: (decision, note) => ({
              path: `/api/v1/budgets/${budget.id}/decisions`,
              body: { decision, ...(note ? { note } : {}) },
            }),
          })
        }
      >
        Decide
      </Button>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export function DecisionNotice({ children }: { children: React.ReactNode }) {
  return <Alert tone="info">{children}</Alert>;
}

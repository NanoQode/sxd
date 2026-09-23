import type { DiscrepancyThreadDto } from '@simplexd/contracts';
import { Badge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';

const PROPOSAL_LABEL: Record<string, string> = {
  replace: 'replace the goods',
  credit: 'issue a credit',
  dispute: 'dispute the finding',
};

const STATE_LABEL: Record<DiscrepancyThreadDto['responseState'], string> = {
  awaiting_supplier: 'Awaiting supplier',
  responded: 'Supplier responded — decision needed',
  rejected: 'Proposal rejected — awaiting supplier',
  accepted: 'Proposal accepted',
  closed: 'Closed',
};

/**
 * The supplier's replies and staff decisions on one discrepancy (server-safe).
 * Accepting closes the discrepancy on the supplier's proposal (or the outcome
 * chosen here) with the reason as resolution note; rejecting keeps it open
 * and lets the supplier reply again. The supplier is notified either way.
 */
export function DiscrepancyDecisions({
  thread,
  deliveryId,
  canManage,
}: {
  thread: DiscrepancyThreadDto;
  deliveryId: string;
  canManage: boolean;
}) {
  const d = thread.discrepancy;
  const latestProposal = [...thread.entries]
    .reverse()
    .find((e) => e.kind === 'supplier_response')?.proposedResolution;
  const defaultOutcome = latestProposal === 'credit' ? 'credited' : 'resolved';
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs">
        <Badge
          tone={
            thread.responseState === 'responded'
              ? 'primary'
              : thread.responseState === 'accepted'
                ? 'success'
                : thread.responseState === 'rejected'
                  ? 'danger'
                  : 'neutral'
          }
        >
          {STATE_LABEL[thread.responseState]}
        </Badge>
      </p>
      {thread.entries.length > 0 ? (
        <ol className="space-y-1 text-sm" aria-label="Supplier responses and decisions">
          {thread.entries.map((e) => (
            <li key={e.id} className="rounded-md border border-border bg-bg-elevated p-2">
              <p className="text-xs text-fg-muted">
                {e.kind === 'supplier_response' ? 'Supplier' : 'Staff'} ·{' '}
                {e.authorName ?? e.authorUserId} · {formatDateTimeLabel(e.createdAt)}
                {e.kind === 'supplier_response' && e.proposedResolution
                  ? ` · proposes to ${PROPOSAL_LABEL[e.proposedResolution] ?? e.proposedResolution}`
                  : ''}
                {e.kind === 'staff_decision'
                  ? ` · ${e.decision === 'accept' ? `accepted as ${humanize(e.outcome ?? 'resolved')}` : 'rejected'}`
                  : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{e.text}</p>
              {e.evidenceFileIds.length > 0 ? (
                <p className="mt-1 text-xs text-fg-muted">
                  {e.evidenceFileIds.length} evidence file
                  {e.evidenceFileIds.length === 1 ? '' : 's'} linked to the delivery (see the
                  project evidence tab).
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {canManage && thread.canDecide ? (
        <span className="flex flex-wrap gap-1">
          <FormDialog
            trigger="Accept proposal"
            variant="primary"
            title="Accept the supplier's proposal"
            description={`The supplier proposes to ${PROPOSAL_LABEL[latestProposal ?? ''] ?? 'resolve this'}. Accepting closes the discrepancy with the outcome below; the reason becomes the resolution note.`}
            path={`/api/v1/deliveries/${deliveryId}/discrepancies/${d.id}/decide`}
            successMessage="Proposal accepted; discrepancy closed"
            submitLabel="Accept"
            extraBody={{ decision: 'accept' }}
            fields={[
              {
                name: 'outcome',
                label: 'Close as',
                type: 'select',
                required: true,
                defaultValue: defaultOutcome,
                options: [
                  { value: 'resolved', label: 'Resolved (replacement or agreed fix)' },
                  { value: 'credited', label: 'Credited' },
                  { value: 'returned', label: 'Returned' },
                ],
              },
              { name: 'reason', label: 'Resolution note', type: 'textarea', required: true },
            ]}
          />
          <ApiAction
            path={`/api/v1/deliveries/${deliveryId}/discrepancies/${d.id}/decide`}
            body={{ decision: 'reject' }}
            reasonKey="reason"
            label="Reject proposal"
            variant="ghost"
            confirm={{
              title: 'Reject the supplier proposal?',
              description: 'The discrepancy stays open and the supplier can reply again.',
              requireReason: true,
              reasonLabel: 'Reason sent to the supplier',
              confirmLabel: 'Reject',
              tone: 'danger',
            }}
            successMessage="Proposal rejected; supplier notified"
          />
        </span>
      ) : null}
    </div>
  );
}

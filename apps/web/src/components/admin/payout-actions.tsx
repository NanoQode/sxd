import { ApiAction } from './api-action';
import { FormDialog } from './form-dialog';

/**
 * Next-step controls for an owner payout (server-safe). Two different people
 * approve: the proposer cannot give the first approval, and the second
 * approver must differ from the first. The server enforces both and requires
 * a verified authenticator; the disabled states here only explain it.
 */
export function PayoutActions({
  payout,
  me,
  perms,
}: {
  payout: { id: string; status: string; proposedBy: string | null; firstApproverId: string | null };
  me: string;
  perms: { first: boolean; second: boolean; reconcile: boolean };
}) {
  const p = payout;
  return (
    <span className="flex flex-wrap gap-1">
      {p.status === 'proposed' && perms.first ? (
        <ApiAction
          path={`/api/v1/payouts/${p.id}/first-approve`}
          label="First approval"
          variant="primary"
          disabled={p.proposedBy === me}
          disabledReason="You proposed this payout; someone else gives the first approval."
          confirm={{
            title: 'Give the first approval?',
            description: 'Checks that the statement reconciliation is balanced.',
            confirmLabel: 'Approve',
          }}
          successMessage="First approval recorded"
        />
      ) : null}
      {p.status === 'first_approved' && perms.second ? (
        <ApiAction
          path={`/api/v1/payouts/${p.id}/second-approve`}
          label="Second approval"
          variant="primary"
          disabled={p.firstApproverId === me}
          disabledReason="You gave the first approval; a different approver must give the second."
          confirm={{
            title: 'Give the second approval?',
            description:
              'Posts the owner distribution journal (Dr 2100 / Cr 2400). The transfer can then be submitted to the bank.',
            confirmLabel: 'Approve',
          }}
          successMessage="Payout approved"
        />
      ) : null}
      {['proposed', 'first_approved'].includes(p.status) && perms.first ? (
        <ApiAction
          path={`/api/v1/payouts/${p.id}/reject`}
          reasonKey="reason"
          label="Reject"
          variant="ghost"
          confirm={{
            title: 'Reject this payout?',
            requireReason: true,
            confirmLabel: 'Reject',
            tone: 'danger',
          }}
          successMessage="Payout rejected"
        />
      ) : null}
      {p.status === 'approved' && perms.reconcile ? (
        <ApiAction
          path={`/api/v1/payouts/${p.id}/submit`}
          label="Mark submitted to bank"
          confirm={{
            title: 'Mark as submitted?',
            description:
              'Records that the transfer instruction was sent. It is not settled until the bank confirms.',
            confirmLabel: 'Mark submitted',
          }}
          successMessage="Marked submitted"
        />
      ) : null}
      {p.status === 'submitted' && perms.reconcile ? (
        <>
          <FormDialog
            trigger="Record settlement"
            title="Record settlement"
            description="Enter the bank's settlement reference from the statement. Posts Dr 2400 / Cr 1000."
            path={`/api/v1/payouts/${p.id}/settle`}
            idempotent
            successMessage="Settlement recorded"
            fields={[
              { name: 'settlementReference', label: 'Settlement reference', required: true },
            ]}
          />
          <ApiAction
            path={`/api/v1/payouts/${p.id}/fail`}
            reasonKey="reason"
            label="Mark failed"
            variant="ghost"
            confirm={{
              title: 'Mark as failed?',
              requireReason: true,
              confirmLabel: 'Mark failed',
              tone: 'danger',
            }}
            successMessage="Marked failed"
          />
        </>
      ) : null}
    </span>
  );
}

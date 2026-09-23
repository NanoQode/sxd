import type { PartnerInvoiceDto } from '@simplexd/contracts';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';

/**
 * Next-step controls for a partner invoice (server-safe). Finance accepts
 * (first approval, posts the payable) or rejects with a reason; a different
 * approver gives the second approval; finance then submits the transfer and
 * records settlement against the bank reference. The server enforces every
 * rule and requires a verified authenticator; the disabled states only
 * explain them.
 */
export function PartnerInvoiceActions({
  invoice,
  me,
  perms,
}: {
  invoice: PartnerInvoiceDto;
  me: string;
  perms: { first: boolean; second: boolean; reconcile: boolean };
}) {
  const i = invoice;
  const base = `/api/v1/partner-invoices/${i.id}`;
  return (
    <span className="flex flex-wrap gap-1">
      {i.status === 'proposed' && perms.first ? (
        <ApiAction
          path={`${base}/accept`}
          label="Accept"
          variant="primary"
          reasonKey="note"
          confirm={{
            title: 'Accept this invoice?',
            description:
              'Records the first approval and posts the payable (Dr 5200 materials or 5300 professional fees / Cr 2400). A different approver must still authorise payment.',
            reasonLabel: 'Note to the partner (optional)',
            confirmLabel: 'Accept',
          }}
          successMessage="Invoice accepted; awaiting second approval"
        />
      ) : null}
      {['proposed', 'first_approved'].includes(i.status) && perms.first ? (
        <ApiAction
          path={`${base}/reject`}
          reasonKey="reason"
          label="Reject"
          variant="ghost"
          confirm={{
            title: 'Reject this invoice?',
            description:
              i.status === 'first_approved'
                ? 'The payable already posted is reversed. The partner sees the reason.'
                : 'The partner sees the reason and may submit a corrected invoice.',
            requireReason: true,
            reasonLabel: 'Reason sent to the partner',
            confirmLabel: 'Reject',
            tone: 'danger',
          }}
          successMessage="Invoice rejected"
        />
      ) : null}
      {i.status === 'first_approved' && perms.second ? (
        <ApiAction
          path={`${base}/second-approve`}
          label="Second approval"
          variant="primary"
          disabled={i.firstApproverId === me}
          disabledReason="You accepted this invoice; a different approver must give the second approval."
          confirm={{
            title: 'Authorise payment?',
            description: 'Second approval by a different person. The transfer can then be submitted to the bank.',
            confirmLabel: 'Approve',
          }}
          successMessage="Payment authorised"
        />
      ) : null}
      {i.status === 'approved' && perms.reconcile ? (
        <ApiAction
          path={`${base}/submit-payment`}
          label="Mark submitted to bank"
          confirm={{
            title: 'Mark as submitted?',
            description: 'Records that the transfer instruction was sent. It is not settled until the bank confirms.',
            confirmLabel: 'Mark submitted',
          }}
          successMessage="Marked submitted"
        />
      ) : null}
      {i.status === 'submitted' && perms.reconcile ? (
        <>
          <FormDialog
            trigger="Record settlement"
            title="Record settlement"
            description="Enter the bank's settlement reference from the statement. Posts Dr 2400 / Cr 1000 and tells the partner the invoice is paid."
            path={`${base}/settle`}
            successMessage="Settlement recorded"
            fields={[{ name: 'settlementReference', label: 'Settlement reference', required: true }]}
          />
          <ApiAction
            path={`${base}/fail`}
            reasonKey="reason"
            label="Mark failed"
            variant="ghost"
            confirm={{ title: 'Mark as failed?', requireReason: true, confirmLabel: 'Mark failed', tone: 'danger' }}
            successMessage="Marked failed"
          />
        </>
      ) : null}
      {i.status === 'failed' && perms.second ? (
        <ApiAction
          path={`${base}/second-approve`}
          label="Re-approve payment"
          reasonKey="reason"
          confirm={{
            title: 'Re-approve after a failed transfer?',
            requireReason: true,
            reasonLabel: 'What was corrected',
            confirmLabel: 'Re-approve',
          }}
          successMessage="Payment re-approved"
        />
      ) : null}
    </span>
  );
}

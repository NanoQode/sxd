import { Alert, Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listChangeOrders } from '@/server/projects/change-orders';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';

export async function ChangeOrdersTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listChangeOrders(identity, p.id, { limit: 100 });
  const perms = shell.permissions;
  const me = identity.session?.user.id;
  return (
    <div className="space-y-6">
      <Alert tone="info" title="Approved budgets change only through change orders">
        A change order alters the approved budget and forecast only once every approval the policy requires (customer and/or staff) is present. Pending deltas are shown separately in the variance.
      </Alert>
      <Section
        title={`Change orders (${items.length})`}
        actions={
          perms.manage ? (
            <FormDialog
              trigger="Draft change order"
              title="Draft a change order"
              path={`/api/v1/projects/${p.id}/change-orders`}
              successMessage="Change order drafted"
              fields={[
                { name: 'title', label: 'Title', required: true, wide: true },
                { name: 'amountDeltaKobo', label: 'Cost delta (₦, negative for savings)', type: 'naira', required: true, hint: 'Prefix with - for a reduction.' },
                { name: 'scheduleDeltaDays', label: 'Schedule delta (days)', type: 'number', defaultValue: 0, min: -3650, max: 3650 },
                { name: 'requiresCustomerApproval', label: 'Requires customer approval', type: 'checkbox', defaultValue: true },
                { name: 'requiresStaffApproval', label: 'Requires staff approval', type: 'checkbox', defaultValue: true },
                { name: 'description', label: 'Description', type: 'textarea', emptyAs: 'null' },
              ]}
            />
          ) : null
        }
      >
        {items.length === 0 ? <p className="text-fg-muted">No change orders.</p> : null}
        <ul className="space-y-3">
          {items.map((co) => {
            const staffPending = co.approvals.find((a) => a.approverRole === 'staff' && a.status === 'pending');
            const isCreator = co.createdBy === me;
            return (
              <li key={co.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">
                      CO-{co.number} · {co.title}
                    </span>{' '}
                    <span className="text-xs text-fg-muted">{formatDateTimeLabel(co.createdAt)}</span>
                  </div>
                  <span className="flex flex-wrap items-center gap-2">
                    <Money kobo={co.amountDeltaKobo} /> · {co.scheduleDeltaDays >= 0 ? '+' : ''}{co.scheduleDeltaDays}d
                    <StatusBadge status={co.status === 'approved' ? 'accepted' : co.status === 'submitted' || co.status === 'customer_review' || co.status === 'staff_review' ? 'in_review' : co.status} label={humanize(co.status)} />
                  </span>
                </div>
                {co.description ? <p className="mt-1 text-sm">{co.description}</p> : null}
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <Badge tone={co.approvalPolicy.outcome === 'approved' ? 'success' : co.approvalPolicy.outcome === 'rejected' ? 'danger' : 'warning'}>
                    Policy {humanize(co.approvalPolicy.outcome)}
                    {co.approvalPolicy.missing.length > 0 ? ` · missing ${co.approvalPolicy.missing.join(', ')}` : ''}
                  </Badge>
                  {co.approvals.map((a) => (
                    <Badge key={a.id} tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'neutral'}>
                      {humanize(a.approverRole)}: {humanize(a.status)}
                      {a.decisionNote ? ` · ${a.decisionNote}` : ''}
                    </Badge>
                  ))}
                  {co.appliedBudgetVersionId ? <Badge tone="info">applied to budget</Badge> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {co.status === 'draft' && perms.manage ? (
                    <ApiAction path={`/api/v1/change-orders/${co.id}/submit`} label="Submit for approval" variant="primary" body={{ expectedVersion: co.version }} confirm={{ title: `Submit CO-${co.number}?`, description: 'Creates the pending approvals required by the policy.', confirmLabel: 'Submit' }} successMessage="Submitted" />
                  ) : null}
                  {staffPending && perms.changeOrdersApprove ? (
                    <>
                      <ApiAction path={`/api/v1/change-orders/${co.id}/approve`} label="Approve (staff)" variant="primary" body={{ approverRole: 'staff', decision: 'approved', expectedVersion: co.version }} reasonKey="note" confirm={{ title: `Approve CO-${co.number} as staff?`, description: 'The budget changes only once the customer approval (if required) is also present.', confirmLabel: 'Approve' }} successMessage="Staff approval recorded" />
                      <ApiAction path={`/api/v1/change-orders/${co.id}/approve`} label="Reject" variant="danger" body={{ approverRole: 'staff', decision: 'rejected', expectedVersion: co.version }} reasonKey="note" confirm={{ title: `Reject CO-${co.number}?`, requireReason: true, confirmLabel: 'Reject', tone: 'danger' }} successMessage="Rejected" />
                    </>
                  ) : null}
                  {staffPending && !perms.changeOrdersApprove ? <span className="text-xs text-fg-muted">Staff approval needs change_orders.staff_approve.</span> : null}
                  {['submitted', 'customer_review', 'staff_review'].includes(co.status) && isCreator && co.approvals.every((a) => a.status === 'pending') ? (
                    <ApiAction path={`/api/v1/change-orders/${co.id}/withdraw`} label="Withdraw" variant="ghost" body={{ expectedVersion: co.version }} reasonKey="reason" confirm={{ title: 'Withdraw this change order?', requireReason: true, confirmLabel: 'Withdraw' }} successMessage="Withdrawn" />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

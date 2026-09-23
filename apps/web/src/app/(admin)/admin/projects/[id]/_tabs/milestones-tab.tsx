import Link from 'next/link';
import { Alert, Badge, StatusBadge, formatDateLabel, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listMilestones } from '@/server/projects/milestones';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';

export async function MilestonesTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listMilestones(identity, p.id);
  const perms = shell.permissions;
  const mfa = identity.actor.mfaVerified;
  return (
    <div className="space-y-6">
      {perms.financeAuthorize && !mfa ? (
        <Alert tone="warning" title="Finance authorisation needs a verified authenticator">
          <Link href="/admin/security/mfa" className="underline">
            Enrol or verify your authenticator
          </Link>{' '}
          before authorising milestone payments.
        </Alert>
      ) : null}
      <Section
        title={`Milestones (${items.length})`}
        description="Three separate signals: the inspector's progress estimate, the customer's acceptance, and finance's payment authorisation. None implies another."
        actions={
          perms.manage ? (
            <FormDialog
              trigger="Add milestone"
              title="Add a milestone"
              path={`/api/v1/projects/${p.id}/milestones`}
              successMessage="Milestone created"
              fields={[
                { name: 'name', label: 'Name', required: true, wide: true },
                { name: 'plannedDate', label: 'Planned date', type: 'date', emptyAs: 'null' },
                { name: 'forecastDate', label: 'Forecast date', type: 'date', emptyAs: 'null' },
                { name: 'description', label: 'Description', type: 'textarea', emptyAs: 'null' },
              ]}
            />
          ) : null
        }
      >
        {items.length === 0 ? <p className="text-fg-muted">No milestones yet.</p> : null}
        <ul className="space-y-3">
          {items.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{m.name}</span>{' '}
                  <span className="text-xs text-fg-muted">
                    planned {m.plannedDate ? formatDateLabel(m.plannedDate) : '—'} · forecast {m.forecastDate ? formatDateLabel(m.forecastDate) : '—'}
                  </span>
                </div>
                <StatusBadge status={m.status === 'accepted' ? 'accepted' : m.status === 'submitted' ? 'in_review' : m.status} label={humanize(m.status)} />
              </div>
              {m.description ? <p className="mt-1 text-sm">{m.description}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <Badge tone="neutral">Inspector progress: {m.inspectorProgressPct !== null ? `${m.inspectorProgressPct}%` : 'not recorded'}{m.inspectorProgressAt ? ` (${formatDateTimeLabel(m.inspectorProgressAt)})` : ''}</Badge>
                <Badge tone={m.customerAcceptedAt ? 'success' : 'neutral'}>Customer acceptance: {m.customerAcceptedAt ? formatDateTimeLabel(m.customerAcceptedAt) : m.customerRejectedReason ? `rejected: ${m.customerRejectedReason}` : 'pending'}</Badge>
                <Badge tone={m.financeAuthorizedAt ? 'success' : 'neutral'}>Finance authorisation: {m.financeAuthorizedAt ? formatDateTimeLabel(m.financeAuthorizedAt) : 'none'}</Badge>
                {m.paymentInvoiceId ? (
                  <Link href={`/admin/finance/invoices/${m.paymentInvoiceId}`} className="underline">
                    payment invoice
                  </Link>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {perms.milestoneProgress && ['pending', 'in_progress', 'rejected'].includes(m.status) ? (
                  <FormDialog
                    trigger="Record progress"
                    title={`Progress estimate for ${m.name}`}
                    description="An inspector's estimate; it never implies customer acceptance."
                    path={`/api/v1/milestones/${m.id}/progress`}
                    successMessage="Progress recorded"
                    fields={[
                      { name: 'percentComplete', label: 'Percent complete', type: 'number', required: true, min: 0, max: 100, defaultValue: m.inspectorProgressPct ?? 0 },
                      { name: 'note', label: 'Note', type: 'textarea' },
                    ]}
                  />
                ) : null}
                {perms.manage && ['pending', 'in_progress'].includes(m.status) ? (
                  <ApiAction path={`/api/v1/milestones/${m.id}/submit`} label="Submit for customer acceptance" body={{}} confirm={{ title: `Submit ${m.name} for acceptance?`, description: 'The customer is asked to accept or reject with a reason.', confirmLabel: 'Submit' }} successMessage="Submitted" />
                ) : null}
                {perms.manage && m.status === 'rejected' ? (
                  <ApiAction path={`/api/v1/milestones/${m.id}/rework`} label="Restart work" body={{}} successMessage="Milestone back in progress" />
                ) : null}
                {perms.financeAuthorize && m.status === 'accepted' && !m.financeAuthorizedAt ? (
                  <FormDialog
                    trigger="Authorise payment (finance)"
                    title={`Authorise payment for ${m.name}`}
                    description="Requires a verified authenticator. Optionally link the invoice that pays this milestone."
                    path={`/api/v1/milestones/${m.id}/finance-authorization`}
                    successMessage="Payment authorised"
                    variant="primary"
                    disabled={!mfa}
                    disabledReason="Verify your authenticator first"
                    fields={[
                      { name: 'paymentInvoiceId', label: 'Payment invoice id (optional)', hint: 'UUID of an existing invoice', emptyAs: 'null' },
                      { name: 'note', label: 'Note', type: 'textarea' },
                    ]}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

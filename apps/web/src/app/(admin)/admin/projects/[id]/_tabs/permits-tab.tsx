import { permitEventTypeSchema } from '@simplexd/contracts';
import { Badge, StatusBadge, formatDateLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listPermits } from '@/server/projects/permits';
import { FormDialog } from '@/components/admin/form-dialog';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';

export async function PermitsTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listPermits(identity, p.id);
  const canManage = shell.permissions.manage;
  return (
    <Section
      title={`Permit applications (${items.length})`}
      description="Elapsed time is split between the applicant's and the authority's court. A statutory target is shown only when it was recorded with a source; otherwise it reads unknown."
      actions={
        canManage ? (
          <FormDialog
            trigger="New application"
            title="New permit application"
            path={`/api/v1/projects/${p.id}/permits`}
            successMessage="Application created"
            fields={[
              { name: 'jurisdiction', label: 'Jurisdiction', required: true, placeholder: 'e.g. Lagos State' },
              { name: 'authority', label: 'Authority', required: true, placeholder: 'e.g. LASPPPA' },
              { name: 'permitType', label: 'Permit type', required: true, placeholder: 'e.g. Building permit' },
              { name: 'documentType', label: 'Document type' },
              { name: 'applicationReference', label: 'Application reference' },
              { name: 'feesKobo', label: 'Fees (₦)', type: 'naira' },
              { name: 'statutoryDays', label: 'Statutory target (days)', type: 'number', min: 1, max: 3650, hint: 'Only with a source note below.' },
              { name: 'statutoryBasis', label: 'Target basis', type: 'select', options: [{ value: 'business', label: 'Business days' }, { value: 'elapsed', label: 'Elapsed days' }] },
              { name: 'statutorySource', label: 'Source of the statutory figure', type: 'textarea', hint: 'Regulation, circular or official page. Required when a target is entered.' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            transform="permitApplication"
            extraBody={{ propertyId: p.propertyId }}
          />
        ) : null
      }
    >
      {items.length === 0 ? <p className="text-fg-muted">No permit applications tracked.</p> : null}
      <ul className="space-y-3">
        {items.map((pa) => (
          <li key={pa.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">
                  {pa.permitType} · {pa.authority}
                </span>{' '}
                <span className="text-xs text-fg-muted">{pa.jurisdiction}{pa.applicationReference ? ` · ref ${pa.applicationReference}` : ''}</span>
              </div>
              <StatusBadge status={pa.status === 'approved' ? 'accepted' : pa.status === 'submitted' || pa.status === 'resubmitted' ? 'in_review' : pa.status === 'query_raised' ? 'paused' : pa.status === 'preparing' ? 'draft' : pa.status} label={humanize(pa.status)} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1 text-xs">
              {pa.elapsed ? (
                <Badge tone="neutral">
                  {humanize(pa.elapsed.status)} · applicant {pa.elapsed.applicantDays}d · authority {pa.elapsed.authorityDays}d · total {pa.elapsed.totalDays} {pa.elapsed.basis} days
                </Badge>
              ) : null}
              <Badge tone={pa.statutoryTargetStatus === 'known' ? 'info' : 'neutral'}>
                Statutory target: {pa.statutoryTarget ? `${pa.statutoryTarget.days} ${pa.statutoryTarget.basis} days (${pa.statutoryTarget.sourceNote})` : 'unknown'}
              </Badge>
              {pa.feesKobo ? <Badge tone="neutral">fees <Money kobo={pa.feesKobo} /></Badge> : null}
              {pa.submittedAt ? <span className="text-fg-muted">submitted {formatDateLabel(pa.submittedAt)}</span> : null}
              {pa.decidedAt ? <span className="text-fg-muted">decided {formatDateLabel(pa.decidedAt)}</span> : null}
            </div>
            {pa.events.length > 0 ? (
              <ol className="mt-2 space-y-1 border-l-2 border-border pl-3 text-xs">
                {pa.events.map((e) => (
                  <li key={e.id}>
                    <strong>{humanize(e.eventType)}</strong> · {formatDateLabel(e.occurredAt)}
                    {e.note ? ` · ${e.note}` : ''}
                  </li>
                ))}
              </ol>
            ) : null}
            {canManage ? (
              <div className="mt-2">
                <FormDialog
                  trigger="Add event"
                  title={`Add an event to ${pa.permitType}`}
                  description="Events are append-only and move the status."
                  path={`/api/v1/permits/${pa.id}/events`}
                  successMessage="Event recorded"
                  fields={[
                    { name: 'eventType', label: 'Event', type: 'select', required: true, options: permitEventTypeSchema.options.map((e) => ({ value: e, label: humanize(e) })) },
                    { name: 'occurredAt', label: 'Occurred on', type: 'date', required: true },
                    { name: 'note', label: 'Note', type: 'textarea', emptyAs: 'null' },
                  ]}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

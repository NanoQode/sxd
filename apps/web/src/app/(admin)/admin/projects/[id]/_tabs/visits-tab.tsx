import Link from 'next/link';
import { Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listSiteVisits } from '@/server/projects/site-visits';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';

export async function VisitsTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listSiteVisits(identity, p.id, { limit: 100 });
  const inspectors = [
    ...shell.staff.filter((s) => s.roles.includes('inspector') || s.roles.includes('project_manager') || s.roles.includes('operations_manager')).map((s) => ({ value: s.userId, label: `${s.name} (staff)` })),
    ...shell.assignments.filter((a) => ['accepted', 'active'].includes(a.status)).map((a) => ({ value: a.assigneeUserId, label: `${a.assigneeName ?? a.assigneeUserId} (${humanize(a.role)}, assigned)` })),
  ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i);
  const me = identity.session?.user.id;
  return (
    <div className="space-y-6">
      <Section
        title={`Site visits (${items.length})`}
        description="Scheduled for a named inspector. Inspectors start and submit visits from their workspace (offline-capable); staff other than the inspector review submissions. Appointment-linked visits show the linked appointment."
        actions={
          shell.permissions.manage ? (
            <FormDialog
              trigger="Schedule visit"
              title="Schedule a site visit"
              path={`/api/v1/projects/${p.id}/site-visits`}
              successMessage="Visit scheduled"
              fields={[
                { name: 'inspectorUserId', label: 'Inspector', type: 'select', required: true, options: inspectors, hint: 'Staff inspectors and accepted partner assignments.' },
                { name: 'scheduledAt', label: 'Scheduled at', type: 'datetime', required: true },
                { name: 'instructions', label: 'Instructions and checklist notes', type: 'textarea', emptyAs: 'null' },
              ]}
              extraBody={{ serviceRequestId: p.serviceRequestId, propertyId: p.propertyId }}
            />
          ) : null
        }
      >
        {items.length === 0 ? <p className="text-fg-muted">No site visits scheduled.</p> : null}
        <ul className="space-y-3">
          {items.map((v) => (
            <li key={v.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{v.scheduledAt ? formatDateTimeLabel(v.scheduledAt) : 'Unscheduled'}</span>{' '}
                  <span className="text-xs text-fg-muted">inspector {v.inspectorName ?? v.inspectorUserId ?? '—'}</span>
                </div>
                <span className="flex flex-wrap gap-2">
                  <StatusBadge status={v.status === 'scheduled' ? 'pending' : v.status === 'reviewed' ? 'completed' : v.status === 'submitted' ? 'in_review' : v.status} label={humanize(v.status)} />
                  <Badge tone="neutral">{v.evidenceCount} evidence</Badge>
                  {v.appointmentId ? (
                    <Link href={`/admin/appointments?view=day&date=${(v.scheduledAt ?? '').slice(0, 10)}`} className="text-xs underline">
                      appointment
                    </Link>
                  ) : null}
                </span>
              </div>
              {v.instructions ? <p className="mt-1 whitespace-pre-wrap text-sm">{v.instructions}</p> : null}
              {v.findingsMarkdown ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-fg-muted">Findings{v.weather ? ` · weather: ${v.weather}` : ''}</summary>
                  <p className="mt-1 whitespace-pre-wrap rounded-md bg-bg-sunken p-2 text-sm">{v.findingsMarkdown}</p>
                  {v.accessNote ? <p className="text-xs text-fg-muted">Access: {v.accessNote}</p> : null}
                </details>
              ) : null}
              <p className="mt-1 text-xs text-fg-muted">
                {v.startedAt ? `started ${formatDateTimeLabel(v.startedAt)}` : ''}
                {v.submittedAt ? ` · submitted ${formatDateTimeLabel(v.submittedAt)}` : ''}
                {v.reviewedAt ? ` · reviewed ${formatDateTimeLabel(v.reviewedAt)}` : ''}
                {v.offlineClientId ? ' · offline-synced' : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {v.status === 'submitted' && shell.permissions.manage && v.inspectorUserId !== me ? (
                  <ApiAction path={`/api/v1/site-visits/${v.id}/review`} label="Mark reviewed" variant="primary" reasonKey="note" confirm={{ title: 'Review this visit?', description: 'Confirms the findings were reviewed by someone other than the inspector.', confirmLabel: 'Reviewed' }} successMessage="Visit reviewed" />
                ) : null}
                {v.status === 'submitted' && v.inspectorUserId === me ? <span className="text-xs text-fg-muted">You submitted this visit; another staff member must review it.</span> : null}
                {['scheduled', 'in_progress'].includes(v.status) && shell.permissions.manage ? (
                  <ApiAction path={`/api/v1/site-visits/${v.id}/cancel`} label="Cancel" variant="ghost" reasonKey="reason" confirm={{ title: 'Cancel this visit?', requireReason: true, confirmLabel: 'Cancel visit', tone: 'danger' }} successMessage="Visit cancelled" />
                ) : null}
                <Link href={`/admin/projects/${p.id}?tab=evidence&siteVisitId=${v.id}`} className="text-sm underline">
                  Evidence
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

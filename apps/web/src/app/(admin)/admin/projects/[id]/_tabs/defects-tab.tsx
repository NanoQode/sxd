import { accountablePartySchema, defectSeveritySchema, defectStatusSchema } from '@simplexd/contracts';
import { Badge, formatDateLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listDefects } from '@/server/projects/defects';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';

const NEXT: Record<string, string[]> = {
  open: ['acknowledged', 'in_progress', 'disputed'],
  acknowledged: ['in_progress', 'disputed'],
  in_progress: ['resolved', 'disputed'],
  resolved: ['verified', 'in_progress'],
  verified: ['closed'],
  disputed: ['acknowledged', 'closed'],
  closed: [],
};

const SEVERITY_TONE: Record<string, 'neutral' | 'warning' | 'danger' | 'info'> = { cosmetic: 'neutral', minor: 'info', major: 'warning', critical: 'danger', safety: 'danger' };

export async function DefectsTab({ identity, shell }: { identity: RequestIdentity; shell: ProjectShell }) {
  const p = shell.overview.project;
  const { items } = await listDefects(identity, p.id, { limit: 100, unresolvedOnly: false });
  const columns = defectStatusSchema.options;
  const canManage = shell.permissions.manage;
  const canVerify = shell.permissions.reportsReview || shell.permissions.manage;
  return (
    <Section
      title={`Defects board (${items.length})`}
      description="Numbered per project. Verification must be done by someone other than the resolver (server rule)."
      actions={
        canManage ? (
          <FormDialog
            trigger="Raise defect"
            title="Raise a defect"
            path={`/api/v1/projects/${p.id}/defects`}
            successMessage="Defect raised"
            fields={[
              { name: 'title', label: 'Title', required: true, wide: true },
              { name: 'severity', label: 'Severity', type: 'select', required: true, options: defectSeveritySchema.options.map((s) => ({ value: s, label: humanize(s) })), defaultValue: 'minor' },
              { name: 'accountableParty', label: 'Accountable party', type: 'select', required: true, options: accountablePartySchema.options.map((s) => ({ value: s, label: humanize(s) })), defaultValue: 'unknown' },
              { name: 'locationNote', label: 'Location', emptyAs: 'null' },
              { name: 'dueDate', label: 'Due date', type: 'date', emptyAs: 'null' },
              { name: 'description', label: 'Description', type: 'textarea', emptyAs: 'null' },
            ]}
          />
        ) : null
      }
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((status) => {
          const cards = items.filter((d) => d.status === status);
          return (
            <div key={status} className="rounded-md border border-border bg-bg-sunken/40 p-2">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
                {humanize(status)} ({cards.length})
              </p>
              <ul className="space-y-2">
                {cards.map((d) => (
                  <li key={d.id} className="rounded-md border border-border bg-bg-elevated p-2 text-sm">
                    <p className="font-medium">
                      #{d.number ?? '?'} {d.title}
                    </p>
                    <p className="flex flex-wrap gap-1 text-xs">
                      <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{humanize(d.severity)}</Badge>
                      <Badge tone="neutral">{humanize(d.accountableParty)}</Badge>
                      {d.dueDate ? <span className="text-fg-muted">due {formatDateLabel(d.dueDate)}</span> : null}
                    </p>
                    {d.locationNote ? <p className="text-xs text-fg-muted">{d.locationNote}</p> : null}
                    {canManage || canVerify ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(NEXT[d.status] ?? [])
                          .filter((to) => (to === 'verified' ? canVerify : canManage))
                          .map((to) => (
                            <ApiAction
                              key={to}
                              path={`/api/v1/defects/${d.id}/transitions`}
                              label={humanize(to)}
                              variant="ghost"
                              body={{ to }} reasonKey="reason"
                              confirm={to === 'disputed' || to === 'closed' ? { title: `Move #${d.number} to ${humanize(to)}?`, requireReason: to === 'disputed', confirmLabel: humanize(to) } : undefined}
                              successMessage={`Defect ${humanize(to)}`}
                            />
                          ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

import { Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import type { ProjectShell } from '@/lib/admin/server/projects';
import { listDesignOptions } from '@/server/projects/design';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';

export async function DesignTab({
  identity,
  shell,
}: {
  identity: RequestIdentity;
  shell: ProjectShell;
}) {
  const p = shell.overview.project;
  const { items } = await listDesignOptions(identity, p.id);
  const canManage = shell.permissions.manage;
  return (
    <Section
      title={`Design options (${items.length})`}
      description="Versioned deliverables with drawing-anchored comments. Customer sign-off freezes a version; a new version supersedes it with a reason."
      actions={
        canManage ? (
          <FormDialog
            trigger="New design option"
            title="Create a design option"
            path={`/api/v1/projects/${p.id}/design-options`}
            successMessage="Design option created"
            fields={[
              { name: 'title', label: 'Title', required: true, wide: true },
              { name: 'description', label: 'Description', type: 'textarea', emptyAs: 'null' },
              {
                name: 'drawingFileIds',
                label: 'Drawing file ids (comma separated)',
                hint: 'Uploaded, scanned files of this organisation.',
                list: true,
              },
            ]}
          />
        ) : null
      }
    >
      {items.length === 0 ? <p className="text-fg-muted">No design options yet.</p> : null}
      <ul className="space-y-3">
        {items.map((d) => (
          <li key={d.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{d.title}</span>{' '}
                <span className="text-xs text-fg-muted">
                  v{d.version} · {formatDateTimeLabel(d.updatedAt)}
                </span>
              </div>
              <span className="flex gap-1">
                <StatusBadge
                  status={d.status === 'signed_off' ? 'accepted' : d.status}
                  label={humanize(d.status)}
                />
                {d.isCurrentVersion ? <Badge tone="info">current</Badge> : null}
              </span>
            </div>
            {d.description ? <p className="mt-1 text-sm">{d.description}</p> : null}
            <p className="text-xs text-fg-muted">
              {d.drawingFileIds.length} drawing{d.drawingFileIds.length === 1 ? '' : 's'}
              {d.customerSignoffAt
                ? ` · signed off ${formatDateTimeLabel(d.customerSignoffAt)}`
                : ''}
            </p>
            {d.comments.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {d.comments.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-bg-sunken p-2"
                  >
                    <span>
                      <strong>{c.authorName ?? 'Someone'}</strong>{' '}
                      <span className="text-xs text-fg-muted">
                        {formatDateTimeLabel(c.createdAt)}
                      </span>
                      <br />
                      {c.body}
                    </span>
                    {c.resolvedAt ? (
                      <Badge tone="success">resolved</Badge>
                    ) : canManage ? (
                      <ApiAction
                        path={`/api/v1/design-options/${d.id}/comments/${c.id}/resolve`}
                        label="Resolve"
                        variant="ghost"
                        body={{}}
                        successMessage="Comment resolved"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {canManage ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <FormDialog
                  trigger="Comment"
                  title="Add a comment"
                  path={`/api/v1/design-options/${d.id}/comments`}
                  successMessage="Comment added"
                  fields={[{ name: 'body', label: 'Comment', type: 'textarea', required: true }]}
                  extraBody={{ anchor: null }}
                />
                {d.isCurrentVersion ? (
                  <FormDialog
                    trigger="New version"
                    title={`New version of ${d.title}`}
                    description="Supersedes the current version; signed-off versions stay frozen."
                    path={`/api/v1/design-options/${d.id}/versions`}
                    successMessage="New version created"
                    fields={[
                      { name: 'reason', label: 'Reason', required: true, wide: true },
                      {
                        name: 'description',
                        label: 'Description',
                        type: 'textarea',
                        emptyAs: 'null',
                      },
                      {
                        name: 'drawingFileIds',
                        label: 'Drawing file ids (comma separated)',
                        list: true,
                      },
                    ]}
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

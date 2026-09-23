import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { workOrderPrioritySchema } from '@simplexd/contracts';
import { Alert, Badge, PageHeader, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { workOrderWorkspace } from '@/lib/admin/server/rentals';
import { summarizeSla } from '@/lib/admin/sla';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section } from '@/components/admin/section';
import { DefinitionList, Mono } from '../../../_components/bits';

export const metadata: Metadata = { title: 'Work order' };
export const dynamic = 'force-dynamic';

const STEPS = [
  'requested',
  'triaged',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'approved',
  'completed',
  'verified',
  'closed',
];

export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/rentals/work-orders');
  const { id } = await params;
  const loaded = await attempt(() => workOrderWorkspace(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This work order" />;
  }
  const { workOrder: w, canManage, assignees } = loaded.value;
  const v = { expectedVersion: w.version };
  const open = !['closed', 'rejected', 'cancelled'].includes(w.status);
  const sla = summarizeSla(
    w.slaDueAt,
    open && !['completed', 'verified'].includes(w.status) ? w.status : 'completed',
  );
  const currentStep = STEPS.indexOf(w.status);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/rentals/work-orders" className="underline">
            Work orders
          </Link>
        }
        title={w.title}
        description={`${w.propertyName ?? 'Property'}${w.unitLabel ? ` · ${w.unitLabel}` : ''} · ${w.organizationName} · ${humanize(w.category)}`}
        actions={
          <>
            <Badge
              tone={
                w.priority === 'urgent' ? 'danger' : w.priority === 'high' ? 'warning' : 'neutral'
              }
            >
              {w.priority} priority
            </Badge>
            <Badge>{humanize(w.status)}</Badge>
            {w.slaBreached ? (
              <Badge tone="danger">SLA breached</Badge>
            ) : sla.state === 'due_soon' ? (
              <Badge tone="warning">{sla.label}</Badge>
            ) : null}
          </>
        }
      />
      {w.slaBreached ? (
        <Alert tone="danger" title="Past its SLA deadline">
          Due {w.slaDueAt ? formatDateTimeLabel(w.slaDueAt) : '—'}. Dispatch or escalate, and keep
          the owner informed.
        </Alert>
      ) : null}
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === w.status ? 'step' : undefined}
            className={`rounded-full border px-2 py-0.5 ${s === w.status ? 'border-primary bg-primary-soft text-primary' : i < currentStep ? 'border-success/50 text-success' : 'border-border text-fg-muted'}`}
          >
            {humanize(s)}
          </li>
        ))}
      </ol>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title="Request">
            {w.description ? (
              <p className="whitespace-pre-wrap">{w.description}</p>
            ) : (
              <p className="text-fg-muted">No description.</p>
            )}
            <DefinitionList
              items={[
                { term: 'Reported by', value: loaded.value.reportedByName },
                { term: 'Raised', value: formatDateTimeLabel(w.createdAt) },
                { term: 'SLA due', value: w.slaDueAt ? formatDateTimeLabel(w.slaDueAt) : null },
                { term: 'Assignee', value: w.assigneeName },
                {
                  term: 'Lease',
                  value: w.leaseId ? (
                    <Link href={`/admin/rentals/leases/${w.leaseId}`} className="underline">
                      open lease
                    </Link>
                  ) : null,
                },
                {
                  term: 'Property',
                  value: (
                    <Link href={`/admin/properties/${w.propertyId}`} className="underline">
                      {w.propertyName ?? 'open property'}
                    </Link>
                  ),
                },
                { term: 'Recurring', value: w.recurring ? 'preventive schedule' : null },
              ]}
            />
          </Section>
          <Section
            title={`Evidence (${w.evidence.length})`}
            description="Photos and documents of the work. Capture time is what the uploader said; receipt time is the server's."
            actions={
              canManage &&
              ['assigned', 'in_progress', 'approved', 'awaiting_approval'].includes(w.status) ? (
                <FormDialog
                  trigger="Attach evidence"
                  title="Attach evidence"
                  description="Use file ids of clean (scanned) uploads of this organisation or your own."
                  path={`/api/v1/work-orders/${w.id}/evidence`}
                  successMessage="Evidence attached"
                  fields={[
                    {
                      name: 'fileIds',
                      label: 'File ids (comma separated)',
                      required: true,
                      list: true,
                      wide: true,
                    },
                    { name: 'caption', label: 'Caption', emptyAs: 'null' },
                    {
                      name: 'capturedAt',
                      label: 'Captured at (your device time)',
                      type: 'datetime',
                      emptyAs: 'null',
                    },
                  ]}
                />
              ) : undefined
            }
          >
            {w.evidence.length === 0 ? (
              <p className="text-fg-muted">No evidence yet. Completion requires evidence.</p>
            ) : (
              <ul className="space-y-1">
                {w.evidence.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2">
                    <a href={`/api/v1/files/${e.fileId}/download`} className="underline">
                      {e.caption ?? `${humanize(e.kind)} ${e.fileId.slice(0, 8)}`}
                    </a>
                    <span className="text-xs text-fg-muted">
                      captured {e.capturedAt ? formatDateTimeLabel(e.capturedAt) : 'unknown'} ·
                      received {formatDateTimeLabel(e.receivedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="Cost">
            <DefinitionList
              items={[
                { term: 'Estimate', value: <Money kobo={w.estimateKobo} /> },
                {
                  term: 'Approved by owner',
                  value: w.approvedAmountKobo ? (
                    <span>
                      <Money kobo={w.approvedAmountKobo} />{' '}
                      <span className="text-xs text-fg-muted">
                        {loaded.value.approvedByName ?? ''}{' '}
                        {w.approvedAt ? formatDateTimeLabel(w.approvedAt) : ''}
                      </span>
                    </span>
                  ) : null,
                },
                { term: 'Actual cost', value: <Money kobo={w.actualCostKobo} /> },
                {
                  term: 'Verified',
                  value: w.verifiedAt
                    ? `${loaded.value.verifiedByName ?? ''} ${formatDateTimeLabel(w.verifiedAt)}`
                    : null,
                },
                {
                  term: 'Expense journal',
                  value: w.expenseJournalId ? <Mono>{w.expenseJournalId.slice(0, 8)}</Mono> : null,
                },
              ]}
            />
          </Section>
          <Section
            title="Next steps"
            description="Only the steps valid for the current status are offered; the server re-checks who may take them."
          >
            {!canManage ? (
              <p className="text-fg-muted">Read-only: moving work needs maintenance.manage.</p>
            ) : null}
            {canManage ? (
              <div className="flex flex-col items-start gap-2">
                {w.status === 'requested' ? (
                  <FormDialog
                    trigger="Triage"
                    title="Triage"
                    path={`/api/v1/work-orders/${w.id}/triage`}
                    variant="primary"
                    successMessage="Triaged"
                    extraBody={v}
                    fields={[
                      {
                        name: 'priority',
                        label: 'Priority',
                        type: 'select',
                        required: true,
                        defaultValue: w.priority,
                        options: workOrderPrioritySchema.options.map((p) => ({
                          value: p,
                          label: humanize(p),
                        })),
                      },
                      { name: 'category', label: 'Category', defaultValue: w.category },
                      {
                        name: 'estimateKobo',
                        label: 'Estimate (₦)',
                        type: 'naira',
                        emptyAs: 'null',
                      },
                    ]}
                  />
                ) : null}
                {['triaged', 'assigned'].includes(w.status) ? (
                  <FormDialog
                    trigger={w.status === 'assigned' ? 'Reassign' : 'Assign contractor'}
                    title="Dispatch a contractor"
                    description="Creates an accepted contractor assignment; the contractor sees this work order only."
                    path={`/api/v1/work-orders/${w.id}/assign`}
                    variant="primary"
                    successMessage="Assigned"
                    extraBody={v}
                    fields={[
                      {
                        name: 'assigneeUserId',
                        label: 'Contractor',
                        type: 'select',
                        required: true,
                        options: assignees.map((a) => ({
                          value: a.userId,
                          label: `${a.name}${a.kind === 'staff' ? ' (staff)' : ''}`,
                        })),
                      },
                      {
                        name: 'instructions',
                        label: 'Instructions',
                        type: 'textarea',
                        emptyAs: 'null',
                      },
                    ]}
                  />
                ) : null}
                {w.status === 'assigned' ? (
                  <ApiAction
                    path={`/api/v1/work-orders/${w.id}/start`}
                    body={v}
                    label="Start work"
                    successMessage="Work started"
                  />
                ) : null}
                {w.status === 'in_progress' ? (
                  <FormDialog
                    trigger="Request owner approval of cost"
                    title="Request cost approval"
                    description="The owner approves or rejects the estimate."
                    path={`/api/v1/work-orders/${w.id}/request-approval`}
                    successMessage="Approval requested"
                    extraBody={v}
                    fields={[
                      {
                        name: 'estimateKobo',
                        label: 'Estimate (₦)',
                        type: 'naira',
                        required: true,
                      },
                      { name: 'note', label: 'Note', type: 'textarea', emptyAs: 'null' },
                    ]}
                  />
                ) : null}
                {w.status === 'awaiting_approval' ? (
                  <p className="text-sm text-fg-muted">
                    Waiting for the owner to approve the cost.
                  </p>
                ) : null}
                {['awaiting_approval', 'in_progress'].includes(w.status) ? (
                  <ApiAction
                    path={`/api/v1/work-orders/${w.id}/reject`}
                    body={v}
                    reasonKey="reason"
                    label="Reject"
                    variant="ghost"
                    confirm={{
                      title: 'Reject this work order?',
                      requireReason: true,
                      confirmLabel: 'Reject',
                      tone: 'danger',
                    }}
                    successMessage="Rejected"
                  />
                ) : null}
                {['in_progress', 'approved'].includes(w.status) ? (
                  <FormDialog
                    trigger="Complete"
                    title="Complete the work"
                    description="Evidence must be attached first."
                    path={`/api/v1/work-orders/${w.id}/complete`}
                    variant="primary"
                    disabled={w.evidence.length === 0}
                    disabledReason="Attach evidence before completing."
                    successMessage="Completed"
                    extraBody={v}
                    fields={[
                      {
                        name: 'actualCostKobo',
                        label: 'Actual cost (₦)',
                        type: 'naira',
                        emptyAs: 'null',
                      },
                      { name: 'note', label: 'Note', type: 'textarea', emptyAs: 'null' },
                    ]}
                  />
                ) : null}
                {w.status === 'completed' ? (
                  <FormDialog
                    trigger="Verify"
                    title="Verify the completed work"
                    description="Posts the recoverable expense (Dr 5200 / Cr 2400); it is recovered from the owner on the next statement."
                    path={`/api/v1/work-orders/${w.id}/verify`}
                    variant="primary"
                    successMessage="Verified"
                    extraBody={v}
                    fields={[
                      {
                        name: 'costKobo',
                        label: 'Cost to record (₦, blank = actual, then approved)',
                        type: 'naira',
                        emptyAs: 'null',
                      },
                    ]}
                  />
                ) : null}
                {w.status === 'verified' ? (
                  <ApiAction
                    path={`/api/v1/work-orders/${w.id}/close`}
                    body={v}
                    label="Close"
                    variant="primary"
                    successMessage="Closed"
                  />
                ) : null}
                {open && !['completed', 'verified'].includes(w.status) ? (
                  <ApiAction
                    path={`/api/v1/work-orders/${w.id}/cancel`}
                    body={v}
                    reasonKey="reason"
                    label="Cancel"
                    variant="ghost"
                    confirm={{
                      title: 'Cancel this work order?',
                      requireReason: true,
                      confirmLabel: 'Cancel work order',
                      tone: 'danger',
                    }}
                    successMessage="Cancelled"
                  />
                ) : null}
                {!open ? (
                  <p className="text-sm text-fg-muted">
                    This work order is {humanize(w.status).toLowerCase()}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

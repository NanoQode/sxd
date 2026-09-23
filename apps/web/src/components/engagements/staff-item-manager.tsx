'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { EngagementItemDto, EngagementItemKindDto, FileDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { ApiAction } from '@/components/admin/api-action';
import { FileUploader } from '@/components/portal/file-uploader';
import {
  ItemEvidenceList,
  ItemHeading,
  ItemMeta,
  ItemResponses,
  KIND_GROUP_LABELS,
  KIND_ORDER,
  VisibilityBadge,
  groupItems,
} from './item-view';

/**
 * Staff management of a request's engagement records: create items of any
 * kind (severity required for red flags and site findings), edit, assign to
 * staff or an assigned partner, move the status with reasons, attach
 * evidence from the request's files or a fresh upload, and reply. Controls
 * follow `item.can` from the server, so a closed request or a cancelled item
 * shows no dead buttons.
 */

export interface AssigneeOption {
  userId: string;
  name: string;
  kind: 'staff' | 'partner';
  detail?: string;
}

export interface RequestFileOption {
  id: string;
  originalName: string;
  status: string;
}

const KINDS: EngagementItemKindDto[] = KIND_ORDER;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const VISIBILITIES = [
  { value: 'customer', label: 'Customer (and staff)' },
  { value: 'all', label: 'Customer and assigned partners' },
  { value: 'partner', label: 'Assigned partners (and staff)' },
  { value: 'internal', label: 'Staff only' },
] as const;
const SEVERITY_REQUIRED: EngagementItemKindDto[] = ['red_flag', 'site_finding'];

interface ItemForm {
  kind: EngagementItemKindDto;
  title: string;
  detail: string;
  reference: string;
  severity: string;
  visibility: string;
  assigneeUserId: string;
  dueAt: string;
}

function emptyForm(kind: EngagementItemKindDto = 'document_check'): ItemForm {
  return {
    kind,
    title: '',
    detail: '',
    reference: '',
    severity: '',
    visibility: kind === 'closing_task' ? 'all' : 'customer',
    assigneeUserId: '',
    dueAt: '',
  };
}

function formFrom(item: EngagementItemDto): ItemForm {
  return {
    kind: item.kind,
    title: item.title,
    detail: item.detail ?? '',
    reference: item.reference ?? '',
    severity: item.severity ?? '',
    visibility: item.visibility,
    assigneeUserId: item.assigneeUserId ?? '',
    dueAt: item.dueAt ? item.dueAt.slice(0, 16) : '',
  };
}

function ItemFormFields({
  form,
  set,
  assignees,
  editableFields,
}: {
  form: ItemForm;
  set: (patch: Partial<ItemForm>) => void;
  assignees: AssigneeOption[];
  editableFields: string[] | null;
}) {
  const may = (field: string) => editableFields === null || editableFields.includes(field);
  const severityRequired = SEVERITY_REQUIRED.includes(form.kind);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {editableFields === null ? (
        <Field label="Kind" required>
          {({ id }) => (
            <NativeSelect
              id={id}
              value={form.kind}
              onChange={(e) =>
                set({
                  kind: e.target.value as EngagementItemKindDto,
                  visibility: e.target.value === 'closing_task' ? 'all' : form.visibility,
                })
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_GROUP_LABELS[k]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {may('title') ? (
        <Field label="Title" required className="sm:col-span-2">
          {({ id }) => (
            <Input
              id={id}
              value={form.title}
              maxLength={300}
              onChange={(e) => set({ title: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {may('detail') ? (
        <Field label="Detail" className="sm:col-span-2" hint="Shown to whoever can see the item.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              maxLength={8000}
              value={form.detail}
              onChange={(e) => set({ detail: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {may('reference') ? (
        <Field label="Reference" hint="Survey plan, registry entry or instrument number.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={form.reference}
              maxLength={300}
              onChange={(e) => set({ reference: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {may('severity') ? (
        <Field
          label="Severity"
          required={severityRequired}
          hint={severityRequired ? 'Required for red flags and site findings.' : undefined}
        >
          {({ id, describedBy }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              value={form.severity}
              onChange={(e) => set({ severity: e.target.value })}
            >
              <option value="">{severityRequired ? 'Choose…' : 'None'}</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {may('visibility') ? (
        <Field label="Visible to">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={form.visibility}
              onChange={(e) => set({ visibility: e.target.value })}
            >
              {VISIBILITIES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {may('assigneeUserId') ? (
        <Field
          label="Assign to"
          hint="Staff, or a partner whose assignment on this request is accepted or active."
        >
          {({ id, describedBy }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              value={form.assigneeUserId}
              onChange={(e) => set({ assigneeUserId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name} · {a.kind}
                  {a.detail ? ` · ${a.detail}` : ''}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      {may('dueAt') ? (
        <Field label="Due">
          {({ id }) => (
            <Input
              id={id}
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => set({ dueAt: e.target.value })}
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}

function bodyFrom(form: ItemForm, editableFields: string[] | null) {
  const all = editableFields === null;
  const may = (f: string) => all || editableFields!.includes(f);
  return {
    ...(all ? { kind: form.kind } : {}),
    ...(may('title') ? { title: form.title.trim() } : {}),
    ...(may('detail') ? { detail: form.detail.trim() || null } : {}),
    ...(may('reference') ? { reference: form.reference.trim() || null } : {}),
    ...(may('severity') ? { severity: form.severity || null } : {}),
    ...(may('visibility') ? { visibility: form.visibility } : {}),
    ...(may('assigneeUserId') ? { assigneeUserId: form.assigneeUserId || null } : {}),
    ...(may('dueAt') ? { dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null } : {}),
  };
}

function ItemDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  editableFields,
  assignees,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  initial: ItemForm;
  editableFields: string[] | null;
  assignees: AssigneeOption[];
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState<ItemForm>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ItemForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const severityMissing =
    (editableFields === null || editableFields.includes('severity')) &&
    SEVERITY_REQUIRED.includes(form.kind) &&
    !form.severity;
  const titleMissing =
    (editableFields === null || editableFields.includes('title')) && form.title.trim().length === 0;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(bodyFrom(form, editableFields));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent title={title} description={description} size="lg">
        <div className="space-y-3 overflow-y-auto">
          {error ? (
            <Alert tone="danger" title="Could not save">
              {error}
            </Alert>
          ) : null}
          <ItemFormFields
            form={form}
            set={set}
            assignees={assignees}
            editableFields={editableFields}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={severityMissing || titleMissing}
            title={
              severityMissing
                ? 'A severity is required for this kind'
                : titleMissing
                  ? 'A title is required'
                  : undefined
            }
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AttachDialog({
  item,
  files,
  serviceRequestId,
  open,
  onOpenChange,
}: {
  item: EngagementItemDto;
  files: RequestFileOption[];
  serviceRequestId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const attached = new Set(item.evidence.map((e) => e.fileId));
  const candidates = files.filter((f) => !attached.has(f.id) && f.status === 'clean');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function attach(fileIds: string[]) {
    if (fileIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/engagement-items/${item.id}/evidence`, {
        body: { fileIds, expectedVersion: item.version },
      });
      toast({ title: `${fileIds.length} file(s) attached`, tone: 'success' });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent
        title={`Attach evidence to “${item.title}”`}
        description="Pick scanned files already on this request, or upload new ones. Evidence follows the item's visibility."
        size="lg"
      >
        <div className="space-y-4 overflow-y-auto">
          {error ? (
            <Alert tone="danger" title="Could not attach">
              {error}
            </Alert>
          ) : null}
          {candidates.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No other scanned files are on this request yet; upload below.
            </p>
          ) : (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Files on this request</legend>
              {candidates.map((f) => (
                <label key={f.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={selected.includes(f.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, f.id] : prev.filter((id) => id !== f.id),
                      )
                    }
                  />
                  <span className="break-all">{f.originalName}</span>
                </label>
              ))}
            </fieldset>
          )}
          <FileUploader
            purpose="org_document"
            entityType="service_request"
            entityId={serviceRequestId}
            compact
            label="Upload and attach"
            onUploaded={(file: FileDto) => void attach([file.id])}
            refreshOnSettle={false}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button
            onClick={() => void attach(selected)}
            loading={busy}
            disabled={selected.length === 0}
          >
            Attach selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplyForm({ item }: { item: EngagementItemDto }) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/engagement-items/${item.id}/responses`, {
        body: { body: body.trim(), expectedVersion: item.version },
      });
      setBody('');
      toast({ title: 'Reply added', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {error ? (
        <Alert tone="danger" title="Could not reply">
          {error}
        </Alert>
      ) : null}
      <Field
        label="Reply"
        hint={
          item.visibility === 'internal'
            ? 'Staff only: this item is internal.'
            : 'Visible to whoever can see this item; the customer is notified when they can.'
        }
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={4000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void send()}
        loading={busy}
        disabled={body.trim().length === 0}
      >
        Send reply
      </Button>
    </div>
  );
}

function ItemRow({
  item,
  assignees,
  files,
  serviceRequestId,
}: {
  item: EngagementItemDto;
  assignees: AssigneeOption[];
  files: RequestFileOption[];
  serviceRequestId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [replying, setReplying] = useState(false);
  const { can } = item;
  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <ItemHeading item={item} extra={<VisibilityBadge visibility={item.visibility} />} />
      <ItemMeta item={item} zone="Africa/Lagos" />
      <ItemResponses item={item} zone="Africa/Lagos" />
      <ItemEvidenceList item={item} mode="admin" zone="Africa/Lagos" />
      {can.editableFields.length > 0 ||
      can.transitions.length > 0 ||
      can.attachEvidence ||
      can.respond ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {can.editableFields.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {can.transitions.map((t) => (
            <ApiAction
              key={t.to}
              path={`/api/v1/engagement-items/${item.id}/transition`}
              label={transitionLabel(t.to)}
              variant={t.to === 'satisfied' ? 'primary' : 'secondary'}
              body={{ to: t.to, expectedVersion: item.version }}
              reasonKey="reason"
              confirm={
                t.reasonRequired
                  ? {
                      title: `${transitionLabel(t.to)}?`,
                      requireReason: true,
                      reasonLabel: reasonLabel(t.to),
                      confirmLabel: transitionLabel(t.to),
                      tone: t.to === 'cancelled' || t.to === 'failed' ? 'danger' : 'primary',
                    }
                  : undefined
              }
              successMessage={`Item ${humanize(t.to).toLowerCase()}`}
            />
          ))}
          {can.attachEvidence ? (
            <Button size="sm" variant="secondary" onClick={() => setAttaching(true)}>
              Attach evidence
            </Button>
          ) : null}
          {can.respond ? (
            <Button size="sm" variant="ghost" onClick={() => setReplying((v) => !v)}>
              {replying ? 'Hide reply' : 'Reply'}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">No actions are available on this item.</p>
      )}
      {replying && can.respond ? <ReplyForm item={item} /> : null}
      {editing ? (
        <ItemDialog
          open={editing}
          onOpenChange={setEditing}
          title={`Edit “${item.title}”`}
          initial={formFrom(item)}
          editableFields={can.editableFields}
          assignees={assignees}
          submitLabel="Save changes"
          onSubmit={async (body) => {
            await adminFetch(`/api/v1/engagement-items/${item.id}`, {
              method: 'PATCH',
              body: { ...body, expectedVersion: item.version },
            });
            toast({ title: 'Item updated', tone: 'success' });
            router.refresh();
          }}
        />
      ) : null}
      {attaching ? (
        <AttachDialog
          item={item}
          files={files}
          serviceRequestId={serviceRequestId}
          open={attaching}
          onOpenChange={setAttaching}
        />
      ) : null}
    </li>
  );
}

function transitionLabel(to: string): string {
  switch (to) {
    case 'in_progress':
      return 'Start / reopen';
    case 'open':
      return 'Reopen';
    case 'satisfied':
      return 'Mark satisfied';
    case 'failed':
      return 'Mark failed';
    case 'waived':
      return 'Waive';
    case 'cancelled':
      return 'Cancel item';
    default:
      return humanize(to);
  }
}

function reasonLabel(to: string): string {
  switch (to) {
    case 'failed':
      return 'Why the check failed (recorded with the item)';
    case 'waived':
      return 'Why this is waived (scope change, recorded)';
    case 'cancelled':
      return 'Why this is cancelled';
    default:
      return 'Reason (recorded with the item)';
  }
}

export function StaffItemManager({
  serviceRequestId,
  items,
  assignees,
  files,
  canManage,
  requestClosed,
  children,
}: {
  serviceRequestId: string;
  items: EngagementItemDto[];
  assignees: AssigneeOption[];
  files: RequestFileOption[];
  canManage: boolean;
  requestClosed: boolean;
  children?: ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const visible = useMemo(
    () =>
      filter === 'open'
        ? items.filter((i) => i.status === 'open' || i.status === 'in_progress')
        : items,
    [items, filter],
  );
  const groups = groupItems(visible);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">Show</span>
          <NativeSelect
            aria-label="Filter records"
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'open' | 'all')}
          >
            <option value="open">Open only</option>
            <option value="all">All</option>
          </NativeSelect>
        </label>
        {canManage && !requestClosed ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            Add record
          </Button>
        ) : (
          <span className="text-xs text-fg-muted">
            {requestClosed
              ? 'The request is closed; records are read-only.'
              : 'Managing records needs triage or project-management rights on this request.'}
          </span>
        )}
      </div>
      {children}
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {items.length === 0
            ? 'No records yet. Add the document checklist, survey references, findings, queries and red flags as the engagement progresses; the customer sees customer-visible ones on their request page.'
            : 'No open records; switch to “All” to see closed ones.'}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} aria-labelledby={`grp-${group.kind}`} className="space-y-2">
            <h3 id={`grp-${group.kind}`} className="flex items-center gap-2 text-sm font-medium">
              {group.label} <Badge tone="neutral">{group.items.length}</Badge>
            </h3>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  assignees={assignees}
                  files={files}
                  serviceRequestId={serviceRequestId}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      {creating ? (
        <ItemDialog
          open={creating}
          onOpenChange={setCreating}
          title="Add a record"
          description="Red flags and site findings need a severity. Customer-visible queries and red flags notify the customer; assignees are notified of their items."
          initial={emptyForm()}
          editableFields={null}
          assignees={assignees}
          submitLabel="Add record"
          onSubmit={async (body) => {
            await adminFetch(`/api/v1/service-requests/${serviceRequestId}/engagement-items`, {
              body,
            });
            toast({ title: 'Record added', tone: 'success' });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

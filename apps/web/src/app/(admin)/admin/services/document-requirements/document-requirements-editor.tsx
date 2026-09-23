'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
  type Column,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import {
  STAGE_ORDER,
  stageLabel,
  type EngagementStage,
} from '@/lib/services/document-requirements';
import type { DocumentRequirementDto } from '@/server/admin/configuration/document-requirements';
import type { ServiceOption } from '@/server/admin/configuration/shared';

const ALL = '__all__';
const INTAKE = '__intake__';
const STAGES = STAGE_ORDER.filter((s) => s !== 'completed');

export function DocumentRequirementsEditor({
  items,
  services,
  canManage,
}: {
  items: DocumentRequirementDto[];
  services: ServiceOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<DocumentRequirementDto | 'new' | null>(null);
  const [serviceId, setServiceId] = useState(ALL);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState(INTAKE);
  const [required, setRequired] = useState(true);
  const [sensitive, setSensitive] = useState(false);
  const [active, setActive] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(r: DocumentRequirementDto | 'new') {
    setEditing(r);
    setError(null);
    setReason('');
    if (r === 'new') {
      setServiceId(filter);
      setName('');
      setDescription('');
      setStage(INTAKE);
      setRequired(true);
      setSensitive(false);
      setActive(true);
      setSortOrder('0');
    } else {
      setServiceId(r.serviceId ?? ALL);
      setName(r.name);
      setDescription(r.description ?? '');
      setStage(r.stage ?? INTAKE);
      setRequired(r.required);
      setSensitive(r.sensitive);
      setActive(r.active);
      setSortOrder(String(r.sortOrder));
    }
  }

  const ready =
    name.trim().length >= 3 &&
    /^\d+$/.test(sortOrder) &&
    (editing === 'new' || reason.trim().length >= 3);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      serviceId: serviceId === ALL ? null : serviceId,
      name: name.trim(),
      description: description.trim() || null,
      stage: stage === INTAKE ? null : stage,
      required,
      sensitive,
      active,
      sortOrder: Number(sortOrder),
    };
    try {
      if (editing === 'new') {
        await adminFetch('/api/v1/admin/document-requirements', { body });
        toast({ title: 'Requirement added', tone: 'success' });
      } else if (editing) {
        await adminFetch(`/api/v1/admin/document-requirements/${editing.id}`, {
          method: 'PATCH',
          body: { ...body, expectedVersion: editing.version, reason: reason.trim() },
        });
        toast({ title: 'Requirement updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const visible = items.filter((r) =>
    filter === ALL ? true : r.serviceId === filter || r.serviceId === null,
  );
  const columns: Column<DocumentRequirementDto>[] = [
    {
      key: 'name',
      header: 'Document',
      cell: (r) => (
        <span>
          <span className="font-medium">{r.name}</span>
          {r.description ? (
            <span className="block text-xs text-fg-muted">{r.description}</span>
          ) : null}
        </span>
      ),
    },
    { key: 'service', header: 'Service', cell: (r) => r.serviceName ?? 'All services' },
    { key: 'stage', header: 'Needed', cell: (r) => stageLabel(r.stage) },
    {
      key: 'flags',
      header: 'Flags',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={r.required ? 'primary' : 'neutral'}>
            {r.required ? 'Required' : 'Optional'}
          </Badge>
          {r.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
          {!r.active ? <Badge tone="neutral">Inactive</Badge> : null}
        </span>
      ),
    },
    { key: 'order', header: 'Order', cell: (r) => r.sortOrder, hideOnMobile: true },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) =>
        canManage ? (
          <Button size="sm" variant="secondary" onClick={() => open(r)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Show" className="min-w-56">
          {({ id }) => (
            <NativeSelect id={id} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value={ALL}>Every service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {canManage ? <Button onClick={() => open('new')}>Add requirement</Button> : null}
      </div>
      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        caption="Document requirements"
        emptyMessage="No document requirements yet. Run the seed (pnpm db:seed) for the starter lists or add one here."
      />
      <Dialog open={editing !== null} onOpenChange={(v) => !busy && !v && setEditing(null)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title={
            editing === 'new'
              ? 'Add a document requirement'
              : `Edit ${editing === null ? '' : editing.name}`
          }
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <Field label="Applies to" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                >
                  <option value={ALL}>All services</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Document" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={160}
                />
              )}
            </Field>
            <Field label="Why it is needed (shown to the customer)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-16"
                  maxLength={2000}
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Needed from stage"
                required
                hint="The customer sees it once the request reaches this stage."
              >
                {({ id }) => (
                  <NativeSelect id={id} value={stage} onChange={(e) => setStage(e.target.value)}>
                    <option value={INTAKE}>At intake</option>
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {stageLabel(s as EngagementStage)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Sort order" hint="Lower first within a stage.">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                />
                Required (otherwise shown as optional)
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={sensitive}
                  onChange={(e) => setSensitive(e.target.checked)}
                />
                <span>
                  Sensitive (identity or financial document)
                  <span className="block text-xs text-fg-muted">
                    Requested only when the transaction requires it, shown to the customer inside
                    their request with that explanation, and never listed on public pages.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Active
              </label>
            </div>
            {editing !== 'new' ? (
              <Field
                label="Reason (recorded in the audit log)"
                required
                hint="At least 3 characters."
              >
                {({ id }) => (
                  <Textarea
                    id={id}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-h-14"
                  />
                )}
              </Field>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void save()}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { slaStageSchema, staffRoleSchema } from '@simplexd/contracts';
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
  humanize,
  useToast,
  type Column,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import type { ServiceOption } from '@/server/admin/configuration/shared';
import type { SlaPolicyDto } from '@/server/admin/configuration/sla-policies';
import { fmtDate } from '../../_components/bits';

const GLOBAL = '__global__';
const NONE = '__none__';
const STAGES = slaStageSchema.options;
const ROLES = staffRoleSchema.options;

export function SlaPoliciesEditor({
  items,
  services,
  canManage,
}: {
  items: SlaPolicyDto[];
  services: ServiceOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<SlaPolicyDto | 'new' | null>(null);
  const [serviceId, setServiceId] = useState(GLOBAL);
  const [stage, setStage] = useState<(typeof STAGES)[number]>('triage');
  const [hours, setHours] = useState('24');
  const [businessHours, setBusinessHours] = useState(true);
  const [role, setRole] = useState(NONE);
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(p: SlaPolicyDto | 'new') {
    setEditing(p);
    setError(null);
    setReason('');
    if (p === 'new') {
      setServiceId(GLOBAL);
      setStage('triage');
      setHours('24');
      setBusinessHours(true);
      setRole(NONE);
      setActive(true);
    } else {
      setServiceId(p.serviceId ?? GLOBAL);
      setStage(p.stage as (typeof STAGES)[number]);
      setHours(String(p.targetHours));
      setBusinessHours(p.businessHoursOnly);
      setRole(p.escalateToRole ?? NONE);
      setActive(p.active);
    }
  }

  const hoursOk = /^\d+$/.test(hours) && Number(hours) >= 1 && Number(hours) <= 24 * 365;
  const ready = hoursOk && (editing === 'new' || reason.trim().length >= 3);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        await adminFetch('/api/v1/admin/sla-policies', {
          body: {
            serviceId: serviceId === GLOBAL ? null : serviceId,
            stage,
            targetHours: Number(hours),
            businessHoursOnly: businessHours,
            escalateToRole: role === NONE ? null : role,
            active,
          },
        });
        toast({ title: 'SLA policy added', tone: 'success' });
      } else if (editing) {
        await adminFetch(`/api/v1/admin/sla-policies/${editing.id}`, {
          method: 'PATCH',
          body: {
            targetHours: Number(hours),
            businessHoursOnly: businessHours,
            escalateToRole: role === NONE ? null : role,
            active,
            reason: reason.trim(),
            expectedUpdatedAt: editing.updatedAt,
          },
        });
        toast({ title: 'SLA policy updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<SlaPolicyDto>[] = [
    {
      key: 'service',
      header: 'Service',
      cell: (p) => p.serviceName ?? <span className="font-medium">All services</span>,
    },
    { key: 'stage', header: 'Stage', cell: (p) => humanize(p.stage) },
    {
      key: 'target',
      header: 'Target',
      cell: (p) => `${p.targetHours} h${p.businessHoursOnly ? ' (business hours)' : ''}`,
    },
    {
      key: 'escalate',
      header: 'Escalate to',
      cell: (p) => (p.escalateToRole ? humanize(p.escalateToRole) : '—'),
    },
    {
      key: 'active',
      header: 'Status',
      cell: (p) =>
        p.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
    },
    {
      key: 'updated',
      header: 'Updated',
      hideOnMobile: true,
      cell: (p) => <span className="text-xs">{fmtDate(p.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (p) =>
        canManage ? (
          <Button size="sm" variant="secondary" onClick={() => open(p)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => open('new')}>Add policy</Button>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(p) => p.id}
        rowLabel={(p) => `${p.serviceName ?? 'All services'} ${p.stage}`}
        caption="SLA policies"
        emptyMessage="No SLA policies are configured: triage sets no due time unless the triager types one, and analytics reports no SLA breaches."
      />
      <Dialog open={editing !== null} onOpenChange={(v) => !busy && !v && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'Add an SLA policy' : 'Edit SLA policy'}>
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not save">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Service"
                required
                hint="Service and stage cannot change after creation; add a new policy instead."
              >
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={serviceId}
                    disabled={editing !== 'new'}
                    onChange={(e) => setServiceId(e.target.value)}
                  >
                    <option value={GLOBAL}>All services (global)</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Stage" required>
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={stage}
                    disabled={editing !== 'new'}
                    onChange={(e) => setStage(e.target.value as (typeof STAGES)[number])}
                  >
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Target hours" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Escalate to role" hint="Recorded for the future escalation job.">
                {({ id }) => (
                  <NativeSelect id={id} value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value={NONE}>No escalation</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={businessHours}
                onChange={(e) => setBusinessHours(e.target.checked)}
              />
              Count business hours only (triage currently approximates with calendar hours)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Active (one active policy per service and stage)
            </label>
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

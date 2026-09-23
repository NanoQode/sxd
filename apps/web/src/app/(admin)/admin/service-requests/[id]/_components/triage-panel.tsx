'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { StaffAssigneeDto } from '@simplexd/contracts';
import { Alert, Button, Field, Input, NativeSelect, Textarea, formatDateTimeLabel, humanize, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { PRIORITY_LABELS } from '@/lib/admin/sla';

export function TriagePanel({
  request,
  staff,
  permissions,
}: {
  request: { id: string; status: string; version: number; priority: number; assignedPmUserId: string | null; slaDueAt: string | null };
  staff: StaffAssigneeDto[];
  permissions: { triage: boolean; assign: boolean };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pm, setPm] = useState(request.assignedPmUserId ?? '');
  const [priority, setPriority] = useState(String(request.priority));
  const [slaOverride, setSlaOverride] = useState('');
  const [note, setNote] = useState('');
  const [startWork, setStartWork] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInquiry = request.status === 'inquiry';
  const pms = staff.filter((s) => s.roles.some((r) => ['project_manager', 'operations_manager', 'super_admin'].includes(r)));
  const options = pms.length > 0 ? pms : staff;

  async function triage() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{ slaDueAt: string | null }>(`/api/v1/service-requests/${request.id}/triage`, {
        body: {
          assignedPmUserId: pm,
          priority: Number(priority),
          slaDueAt: slaOverride ? new Date(slaOverride).toISOString() : undefined,
          note: note.trim() || undefined,
          expectedVersion: request.version,
        },
      });
      toast({
        title: 'Request triaged',
        description: res.slaDueAt ? `SLA due ${formatDateTimeLabel(res.slaDueAt)}` : 'No SLA policy exists for this service; set a due time manually if needed.',
        tone: 'success',
      });
      setNote('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/service-requests/${request.id}/assign`, {
        body: { assignedPmUserId: pm, startWork, reason: note.trim() || undefined, expectedVersion: request.version },
      });
      toast({ title: startWork ? 'Assigned; work started' : 'Project manager assigned', tone: 'success' });
      setNote('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!permissions.triage && !permissions.assign) {
    return (
      <Alert tone="info" title="Read-only">
        Your role can view requests. Triage needs service_requests.triage; assignment needs service_requests.assign.
      </Alert>
    );
  }
  const terminal = ['completed', 'rejected', 'cancelled'].includes(request.status);
  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" title="Action failed">
          {error}
        </Alert>
      ) : null}
      {terminal ? <p className="text-fg-muted">This request is {humanize(request.status)}; assignment is closed.</p> : null}
      <Field label="Project manager" required hint={pms.length > 0 ? 'Staff with a project-management role.' : 'No project manager role found; showing all staff.'}>
        {({ id }) => (
          <NativeSelect id={id} value={pm} onChange={(e) => setPm(e.target.value)} disabled={terminal}>
            <option value="">Choose</option>
            {options.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name} ({s.roles.map(humanize).join(', ')})
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {isInquiry ? (
        <>
          <Field label="Priority">
            {({ id }) => (
              <NativeSelect id={id} value={priority} onChange={(e) => setPriority(e.target.value)}>
                {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="SLA due (override)" hint="Leave empty to compute from the service's SLA policy.">
            {({ id }) => <Input id={id} type="datetime-local" value={slaOverride} onChange={(e) => setSlaOverride(e.target.value)} />}
          </Field>
        </>
      ) : null}
      <Field label={isInquiry ? 'Triage note (optional)' : 'Reason (optional)'}>
        {({ id }) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16" maxLength={4000} />}
      </Field>
      {!isInquiry && request.status === 'accepted' ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={startWork} onChange={(e) => setStartWork(e.target.checked)} />
          Start work without upfront payment (policy decision; recorded)
        </label>
      ) : null}
      {isInquiry ? (
        <Button size="sm" loading={busy} disabled={!pm || !permissions.triage} onClick={() => void triage()} title={!permissions.triage ? 'Needs service_requests.triage' : undefined}>
          Triage and assign
        </Button>
      ) : (
        <Button size="sm" loading={busy} disabled={!pm || !permissions.assign || terminal || pm === (request.assignedPmUserId ?? '') && !startWork} onClick={() => void assign()} title={!permissions.assign ? 'Needs service_requests.assign' : undefined}>
          {request.assignedPmUserId ? 'Reassign' : 'Assign'} project manager
        </Button>
      )}
    </div>
  );
}

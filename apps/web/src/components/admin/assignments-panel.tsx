'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { assignmentRoleSchema, type AssignmentDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { ApiAction } from './api-action';

export interface AssigneeOption {
  userId: string;
  name: string;
  kind: 'staff' | 'partner';
  detail?: string;
}

/**
 * Assignments on a request or project: propose (staff or partner), activate
 * after acceptance, complete, revoke with a reason. Access for the assignee
 * starts at acceptance and ends immediately on revocation (server rule).
 */
export function AssignmentsPanel({
  target,
  assignments,
  assignees,
  canAssign,
}: {
  target: { serviceRequestId?: string; projectId?: string };
  assignments: AssignmentDto[];
  assignees: AssigneeOption[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [assignee, setAssignee] = useState('');
  const [role, setRole] = useState<string>('inspector');
  const [instructions, setInstructions] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function propose() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch('/api/v1/assignments', {
        body: {
          ...target,
          assigneeUserId: assignee,
          role,
          instructions: instructions.trim() || null,
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        },
      });
      toast({
        title: 'Assignment proposed',
        description: 'The assignee must accept before access starts.',
        tone: 'success',
      });
      setAssignee('');
      setInstructions('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {assignments.length === 0 ? (
        <p className="text-fg-muted">Nobody is assigned yet.</p>
      ) : (
        <ul className="space-y-2">
          {assignments.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div>
                <p className="font-medium">
                  {a.assigneeName ?? a.assigneeUserId}{' '}
                  <span className="text-fg-muted">· {humanize(a.role)}</span>
                </p>
                <p className="text-xs text-fg-muted">
                  Proposed {formatDateTimeLabel(a.createdAt)}
                  {a.startsAt ? ` · from ${formatDateTimeLabel(a.startsAt)}` : ''}
                  {a.endsAt ? ` · until ${formatDateTimeLabel(a.endsAt)}` : ''}
                </p>
                {a.instructions ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm">{a.instructions}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  status={
                    a.status === 'active'
                      ? 'in_progress'
                      : a.status === 'proposed'
                        ? 'pending'
                        : a.status
                  }
                  label={humanize(a.status)}
                />
                {canAssign && a.status === 'accepted' ? (
                  <ApiAction
                    path={`/api/v1/assignments/${a.id}/activate`}
                    label="Activate"
                    successMessage="Assignment activated"
                  />
                ) : null}
                {canAssign && a.status === 'active' ? (
                  <ApiAction
                    path={`/api/v1/assignments/${a.id}/complete`}
                    label="Complete"
                    successMessage="Assignment completed"
                  />
                ) : null}
                {canAssign && ['proposed', 'accepted', 'active'].includes(a.status) ? (
                  <ApiAction
                    path={`/api/v1/assignments/${a.id}/revoke`}
                    label="Revoke"
                    variant="ghost"
                    body={(reason) => ({ reason })}
                    confirm={{
                      title: 'Revoke this assignment?',
                      description:
                        'Access to the record ends immediately. The reason is recorded in the audit log.',
                      requireReason: true,
                      confirmLabel: 'Revoke',
                      tone: 'danger',
                    }}
                    successMessage="Assignment revoked"
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canAssign ? (
        <div className="grid gap-3 rounded-md border border-dashed border-border p-3 sm:grid-cols-2">
          {error ? (
            <div className="sm:col-span-2">
              <Alert tone="danger" title="Could not propose">
                {error}
              </Alert>
            </div>
          ) : null}
          <Field
            label="Assignee"
            required
            hint="Staff or verified partner. Partners see the record only after accepting."
          >
            {({ id }) => (
              <NativeSelect id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Choose a person</option>
                <optgroup label="Staff">
                  {assignees
                    .filter((a) => a.kind === 'staff')
                    .map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {a.name}
                        {a.detail ? ` (${a.detail})` : ''}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Partners">
                  {assignees
                    .filter((a) => a.kind === 'partner')
                    .map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {a.name}
                        {a.detail ? ` (${a.detail})` : ''}
                      </option>
                    ))}
                </optgroup>
              </NativeSelect>
            )}
          </Field>
          <Field label="Role" required>
            {({ id }) => (
              <NativeSelect id={id} value={role} onChange={(e) => setRole(e.target.value)}>
                {assignmentRoleSchema.options.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Starts (optional)">
            {({ id }) => (
              <Input
                id={id}
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            )}
          </Field>
          <Field label="Ends (optional)">
            {({ id }) => (
              <Input
                id={id}
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Instructions (optional)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  className="min-h-20"
                  maxLength={8000}
                />
              )}
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Button size="sm" loading={busy} disabled={!assignee} onClick={() => void propose()}>
              Propose assignment
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

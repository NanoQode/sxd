'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { projectKindSchema, type ProjectDto } from '@simplexd/contracts';
import {
  Alert,
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

export function CreateProjectDialog({
  organizations,
  staff,
  prefill,
}: {
  organizations: Array<{ id: string; name: string }>;
  staff: Array<{ userId: string; name: string }>;
  prefill: { open: boolean; organizationId?: string; serviceRequestId?: string; name?: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(prefill.open);
  const [organizationId, setOrganizationId] = useState(prefill.organizationId ?? '');
  const [name, setName] = useState(prefill.name ?? '');
  const [kind, setKind] = useState<string>('construction_monitoring');
  const [description, setDescription] = useState('');
  const [pm, setPm] = useState('');
  const [startDate, setStartDate] = useState('');
  const [target, setTarget] = useState('');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const project = await adminFetch<ProjectDto>('/api/v1/projects', {
        body: {
          organizationId,
          name: name.trim(),
          kind,
          description: description.trim() || null,
          serviceRequestId: prefill.serviceRequestId || null,
          pmUserId: pm || null,
          startDate: startDate || null,
          targetCompletionDate: target || null,
          grossFloorAreaM2: area.trim() || null,
        },
      });
      toast({ title: 'Project created', tone: 'success' });
      setOpen(false);
      router.push(`/admin/projects/${project.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New project</Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title="Create a project"
          description={
            prefill.serviceRequestId
              ? 'Linked to the service request you came from.'
              : 'Projects belong to one customer organisation.'
          }
          size="lg"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {error ? (
              <div className="sm:col-span-2">
                <Alert tone="danger" title="Could not create">
                  {error}
                </Alert>
              </div>
            ) : null}
            <Field label="Organisation" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={organizationId}
                  onChange={(e) => setOrganizationId(e.target.value)}
                >
                  <option value="">Choose</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Kind" required>
              {({ id }) => (
                <NativeSelect id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {projectKindSchema.options.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Name" required hint="3 to 160 characters.">
                {({ id }) => (
                  <Input
                    id={id}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={160}
                  />
                )}
              </Field>
            </div>
            <Field label="Project manager">
              {({ id }) => (
                <NativeSelect id={id} value={pm} onChange={(e) => setPm(e.target.value)}>
                  <option value="">Assign later</option>
                  {staff.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Gross floor area (m²)" hint="Used by area-rate budgets.">
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  placeholder="e.g. 240"
                />
              )}
            </Field>
            <Field label="Start date">
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              )}
            </Field>
            <Field label="Target completion">
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description">
                {({ id }) => (
                  <Textarea
                    id={id}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="min-h-20"
                    maxLength={8000}
                  />
                )}
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!organizationId || name.trim().length < 3}
              onClick={() => void create()}
            >
              Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

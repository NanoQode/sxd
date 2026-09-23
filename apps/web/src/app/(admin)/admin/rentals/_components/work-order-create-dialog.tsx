'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { workOrderPrioritySchema, type WorkOrderDto } from '@simplexd/contracts';
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

/** Staff-raised maintenance request; the SLA deadline follows from the priority. */
export function WorkOrderCreateDialog({
  properties,
  leaseId,
  propertyId: fixedProperty,
}: {
  properties: Array<{ id: string; name: string }>;
  leaseId?: string;
  propertyId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [propertyId, setPropertyId] = useState(fixedProperty ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [priority, setPriority] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const wo = await adminFetch<WorkOrderDto>('/api/v1/work-orders', {
        body: {
          propertyId,
          leaseId: leaseId ?? null,
          title: title.trim(),
          description: description.trim() || null,
          category: category.trim() || 'other',
          priority,
        },
      });
      toast({ title: 'Work order created', tone: 'success' });
      setOpen(false);
      router.push(`/admin/rentals/work-orders/${wo.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant={leaseId ? 'secondary' : 'primary'}
        size={leaseId ? 'sm' : 'md'}
        onClick={() => setOpen(true)}
      >
        New work order
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title="New work order"
          description="Triage, assignment, approval of the estimate, evidence and verification follow on the work order page."
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Not created">
                {error}
              </Alert>
            ) : null}
            {fixedProperty ? null : (
              <Field label="Property" required>
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={propertyId}
                    onChange={(e) => setPropertyId(e.target.value)}
                  >
                    <option value="">Choose</option>
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            )}
            <Field label="Title" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">
                {({ id }) => (
                  <Input
                    id={id}
                    value={category}
                    maxLength={60}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Priority">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    {workOrderPrioritySchema.options.map((p) => (
                      <option key={p} value={p}>
                        {humanize(p)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            </div>
            <Field label="Description">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-20"
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                loading={busy}
                disabled={!propertyId || title.trim().length < 3}
                onClick={() => void create()}
              >
                Create
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

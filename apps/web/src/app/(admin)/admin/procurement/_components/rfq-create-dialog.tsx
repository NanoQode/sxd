'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { procurementMaterialSchema, type RfqDto } from '@simplexd/contracts';
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

interface ItemDraft {
  material: string;
  specification: string;
  unit: string;
  quantity: string;
}

const EMPTY: ItemDraft = { material: 'cement', specification: '', unit: 'bag', quantity: '' };

export function itemProblem(i: ItemDraft): string | null {
  if (!i.specification.trim()) return 'Specification is required';
  if (!i.unit.trim()) return 'Unit is required';
  if (!/^\d+(\.\d{1,3})?$/.test(i.quantity) || Number(i.quantity) <= 0)
    return 'Quantity must be positive (up to 3 decimals)';
  return null;
}

/** Draft RFQ with items in the buyer's units; suppliers may price in other units only with a declared conversion. */
export function RfqCreateDialog({
  organizations,
}: {
  organizations: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ItemDraft[]>([{ ...EMPTY }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = items.map(itemProblem);
  const valid = Boolean(organizationId) && title.trim().length >= 3 && problems.every((p) => !p);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rfq = await adminFetch<RfqDto>('/api/v1/rfqs', {
        body: {
          organizationId,
          projectId: projectId.trim() || null,
          title: title.trim(),
          notes: notes.trim() || null,
          deliveryAddress:
            city.trim() || address.trim() ? { city: city.trim(), address: address.trim() } : null,
          items: items.map((i, n) => ({
            material: i.material,
            specification: i.specification.trim(),
            unit: i.unit.trim(),
            quantity: i.quantity,
            sortOrder: n,
          })),
        },
      });
      toast({ title: `Draft ${rfq.reference} created`, tone: 'success' });
      setOpen(false);
      router.push(`/admin/procurement/rfqs/${rfq.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function update(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New RFQ</Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title="New request for quotation"
          description="Created as a draft; issue it with a deadline and invited suppliers from the RFQ page."
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Not created">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer organisation" required>
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
              <Field label="Project id (optional)">
                {({ id }) => (
                  <Input id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)} />
                )}
              </Field>
              <div className="sm:col-span-2">
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
              </div>
              <Field label="Delivery city">
                {({ id }) => (
                  <Input
                    id={id}
                    value={city}
                    maxLength={120}
                    onChange={(e) => setCity(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Delivery address">
                {({ id }) => (
                  <Input
                    id={id}
                    value={address}
                    maxLength={400}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Items</legend>
              {items.map((it, i) => (
                <div
                  key={i}
                  className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_2fr_0.8fr_0.8fr_auto] sm:items-end"
                >
                  <Field label="Material">
                    {({ id }) => (
                      <NativeSelect
                        id={id}
                        value={it.material}
                        onChange={(e) => update(i, { material: e.target.value })}
                      >
                        {procurementMaterialSchema.options.map((m) => (
                          <option key={m} value={m}>
                            {humanize(m)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    label={`Item ${i + 1} specification`}
                    required
                    error={problems[i] && it.specification ? problems[i] : undefined}
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        value={it.specification}
                        onChange={(e) => update(i, { specification: e.target.value })}
                        placeholder="e.g. 42.5R Portland, 50 kg"
                      />
                    )}
                  </Field>
                  <Field label="Unit" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        value={it.unit}
                        onChange={(e) => update(i, { unit: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Quantity" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={it.quantity}
                        onChange={(e) => update(i, { quantity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove item ${i + 1}`}
                    disabled={items.length === 1}
                    onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setItems((prev) => [...prev, { ...EMPTY }])}
              >
                <Plus aria-hidden="true" className="h-4 w-4" /> Add item
              </Button>
            </fieldset>
            <Field label="Notes to suppliers">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="min-h-16"
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!valid} onClick={() => void create()}>
                Create draft
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

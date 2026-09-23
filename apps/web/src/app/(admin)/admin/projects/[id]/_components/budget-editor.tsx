'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { BoqItemDto } from '@simplexd/contracts';
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
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { lineAmountKobo, parseNairaToKobo, sumKobo } from '@/lib/admin/money';
import { Money } from '@/components/admin/money';

interface DraftItem {
  code: string;
  description: string;
  category: string;
  unit: string;
  quantity: string;
  rateNaira: string;
}

const EMPTY: DraftItem = {
  code: '',
  description: '',
  category: '',
  unit: 'item',
  quantity: '1',
  rateNaira: '',
};

function parseItems(items: DraftItem[]) {
  return items.map((i) => {
    const rate = parseNairaToKobo(i.rateNaira);
    const qtyOk = /^\d+(\.\d{1,3})?$/.test(i.quantity);
    return {
      ...i,
      rateKobo: rate,
      qtyOk,
      amountKobo: rate && qtyOk ? lineAmountKobo(i.quantity, rate) : null,
    };
  });
}

function ItemsGrid({
  items,
  setItems,
}: {
  items: DraftItem[];
  setItems: (v: DraftItem[]) => void;
}) {
  const parsed = useMemo(() => parseItems(items), [items]);
  const total = sumKobo(parsed.map((i) => i.amountKobo));
  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-[1fr_3fr_1fr_1fr_1fr_1.5fr_1.5fr_auto] gap-2 text-xs text-fg-muted md:grid">
        <span>Code</span>
        <span>Description</span>
        <span>Category</span>
        <span>Unit</span>
        <span>Qty</span>
        <span>Rate ₦</span>
        <span className="text-right">Amount</span>
        <span />
      </div>
      {items.map((it, i) => (
        <div
          key={i}
          className="grid gap-2 rounded-md border border-border p-2 md:grid-cols-[1fr_3fr_1fr_1fr_1fr_1.5fr_1.5fr_auto] md:border-0 md:p-0"
        >
          <Input
            aria-label={`Item ${i + 1} code`}
            placeholder="Code"
            value={it.code}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))
            }
          />
          <Input
            aria-label={`Item ${i + 1} description`}
            placeholder="Description"
            value={it.description}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
            }
          />
          <Input
            aria-label={`Item ${i + 1} category`}
            placeholder="Category"
            value={it.category}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))
            }
          />
          <Input
            aria-label={`Item ${i + 1} unit`}
            placeholder="Unit"
            value={it.unit}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))
            }
          />
          <Input
            aria-label={`Item ${i + 1} quantity`}
            placeholder="Qty"
            value={it.quantity}
            aria-invalid={!parsed[i]?.qtyOk}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
            }
          />
          <Input
            aria-label={`Item ${i + 1} rate in naira`}
            placeholder="Rate ₦"
            inputMode="decimal"
            value={it.rateNaira}
            aria-invalid={it.rateNaira !== '' && !parsed[i]?.rateKobo}
            onChange={(e) =>
              setItems(items.map((x, j) => (j === i ? { ...x, rateNaira: e.target.value } : x)))
            }
          />
          <span className="self-center text-right text-sm">
            <Money kobo={parsed[i]?.amountKobo} />
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove item ${i + 1}`}
            disabled={items.length === 1}
            onClick={() => setItems(items.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setItems([...items, { ...EMPTY }])}>
          Add item
        </Button>
        <span className="text-sm font-medium">
          Total: <Money kobo={total} />
        </span>
      </div>
    </div>
  );
}

function toInputs(items: DraftItem[]) {
  return parseItems(items).map((i, idx) => ({
    code: i.code.trim() || null,
    description: i.description.trim(),
    category: i.category.trim() || null,
    unit: i.unit.trim(),
    quantity: i.quantity,
    rateKobo: i.rateKobo ?? '0',
    sortOrder: idx,
  }));
}

function itemsValid(items: DraftItem[]) {
  return parseItems(items).every(
    (i) => i.description.trim() && i.unit.trim() && i.qtyOk && i.rateKobo,
  );
}

/** Replace the BOQ of an undecided draft version (PUT /budgets/{id}/items). */
export function BoqEditor({
  budgetId,
  items,
  editable,
}: {
  budgetId: string;
  items: BoqItemDto[];
  editable: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<DraftItem[]>(
    items.length > 0
      ? items.map((i) => ({
          code: i.code ?? '',
          description: i.description,
          category: i.category ?? '',
          unit: i.unit,
          quantity: i.quantity,
          rateNaira: (Number(i.rateKobo) / 100).toString(),
        }))
      : [{ ...EMPTY }],
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/budgets/${budgetId}/items`, {
        method: 'PUT',
        body: { items: toInputs(draft) },
      });
      toast({ title: 'BOQ saved', tone: 'success' });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="mt-2 space-y-2">
        {items.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="text-fg-muted">
              <tr>
                <th className="text-left font-medium">Code</th>
                <th className="text-left font-medium">Description</th>
                <th className="text-left font-medium">Unit</th>
                <th className="text-right font-medium">Qty</th>
                <th className="text-right font-medium">Rate</th>
                <th className="text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.code ?? ''}</td>
                  <td>
                    {i.description}
                    {i.category ? <span className="text-fg-muted"> · {i.category}</span> : null}
                  </td>
                  <td>{i.unit}</td>
                  <td className="text-right">{i.quantity}</td>
                  <td className="text-right">
                    <Money kobo={i.rateKobo} />
                  </td>
                  <td className="text-right">
                    <Money kobo={i.amountKobo} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-fg-muted">No items.</p>
        )}
        {editable ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit items
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-3">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error}
        </Alert>
      ) : null}
      <ItemsGrid items={draft} setItems={setDraft} />
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={!itemsValid(draft)} onClick={() => void save()}>
          Save BOQ
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Create a new budget version from area rate, BOQ, accepted quote or a manual total. */
export function NewBudgetVersion({ projectId, hasArea }: { projectId: string; hasArea: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'area_rate' | 'boq' | 'manual' | 'quote'>('boq');
  const [rate, setRate] = useState('');
  const [area, setArea] = useState('');
  const [total, setTotal] = useState('');
  const [quoteVersionId, setQuoteVersionId] = useState('');
  const [contingency, setContingency] = useState('');
  const [inclusions, setInclusions] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    source === 'boq'
      ? itemsValid(items)
      : source === 'area_rate'
        ? Boolean(parseNairaToKobo(rate)) && (hasArea || /^\d+(\.\d{1,2})?$/.test(area))
        : source === 'manual'
          ? Boolean(parseNairaToKobo(total))
          : /^[0-9a-f-]{36}$/i.test(quoteVersionId);

  async function create() {
    setBusy(true);
    setError(null);
    const common = {
      contingencyKobo: contingency ? (parseNairaToKobo(contingency) ?? undefined) : undefined,
      inclusions: inclusions.trim() || null,
      notes: notes.trim() || null,
    };
    const body =
      source === 'boq'
        ? { source, items: toInputs(items), ...common }
        : source === 'area_rate'
          ? {
              source,
              buildRateKoboPerM2: parseNairaToKobo(rate),
              areaM2: area || undefined,
              ...common,
            }
          : source === 'manual'
            ? { source, totalKobo: parseNairaToKobo(total), ...common }
            : { source, quoteVersionId, ...common };
    try {
      await adminFetch(`/api/v1/projects/${projectId}/budgets`, { body });
      toast({
        title: 'Budget version created',
        description: 'It needs the required approvals before it becomes the project budget.',
        tone: 'success',
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New budget version
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title="New budget version"
          description="Amounts are whole naira; the server computes item amounts and totals."
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert tone="danger" title="Could not create">
                {error}
              </Alert>
            ) : null}
            <Field label="Source" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={source}
                  onChange={(e) => setSource(e.target.value as typeof source)}
                >
                  <option value="boq">Bill of quantities</option>
                  <option value="area_rate">Area × build rate</option>
                  <option value="quote">Accepted quote version</option>
                  <option value="manual">Manual total</option>
                </NativeSelect>
              )}
            </Field>
            {source === 'boq' ? <ItemsGrid items={items} setItems={setItems} /> : null}
            {source === 'area_rate' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Build rate per m² (₦)" required>
                  {({ id }) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Area (m²)"
                  required={!hasArea}
                  hint={
                    hasArea
                      ? 'Defaults to the project gross floor area.'
                      : 'The project has no gross floor area; enter it here.'
                  }
                >
                  {({ id }) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={area}
                      onChange={(e) => setArea(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            ) : null}
            {source === 'manual' ? (
              <Field label="Total (₦)" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            {source === 'quote' ? (
              <Field
                label="Accepted quote version id"
                required
                hint="Copy from the service request's accepted quote; the server uses its stored total."
              >
                {({ id }) => (
                  <Input
                    id={id}
                    value={quoteVersionId}
                    onChange={(e) => setQuoteVersionId(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Contingency (₦)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={contingency}
                    onChange={(e) => setContingency(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field label="Inclusions">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={inclusions}
                  onChange={(e) => setInclusions(e.target.value)}
                  className="min-h-16"
                />
              )}
            </Field>
            <Field label="Notes">
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
              <Button loading={busy} disabled={!ready} onClick={() => void create()}>
                Create version
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

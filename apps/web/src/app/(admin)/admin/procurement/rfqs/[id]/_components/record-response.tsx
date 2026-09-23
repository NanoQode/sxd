'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RfqItemDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { parseNairaToKobo } from '@/lib/admin/money';

interface LineDraft {
  price: string;
  unit: string;
  factor: string;
  lead: string;
}

/**
 * Record a supplier's quotation on their behalf (phone, email or paper quote).
 * When the supplier prices in a different unit, the conversion they declared
 * is entered; without one, the comparison reports the line as unknown instead
 * of guessing.
 */
export function RecordResponse({
  rfqId,
  items,
  suppliers,
}: {
  rfqId: string;
  items: RfqItemDto[];
  suppliers: Array<{ userId: string; name: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [supplierUserId, setSupplierUserId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [delivery, setDelivery] = useState('0');
  const [validUntil, setValidUntil] = useState('');
  const [lines, setLines] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(items.map((i) => [i.id, { price: '', unit: i.unit, factor: '', lead: '' }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deliveryKobo = parseNairaToKobo(delivery);
  const lineOk = items.every((i) => {
    const l = lines[i.id]!;
    const kobo = parseNairaToKobo(l.price);
    if (kobo === null || BigInt(kobo) < 0n || !l.unit.trim()) return false;
    if (l.factor && !/^\d+(\.\d{1,6})?$/.test(l.factor)) return false;
    return true;
  });
  const ready =
    (Boolean(supplierUserId) || supplierName.trim().length >= 2) && deliveryKobo !== null && lineOk;

  function update(itemId: string, patch: Partial<LineDraft>) {
    setLines((prev) => ({ ...prev, [itemId]: { ...prev[itemId]!, ...patch } }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/rfqs/${rfqId}/responses`, {
        body: {
          supplierUserId: supplierUserId || undefined,
          supplierName: supplierUserId ? undefined : supplierName.trim(),
          currency: 'NGN',
          deliveryKobo,
          validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null,
          submit: true,
          lines: items.map((i) => {
            const l = lines[i.id]!;
            const differs = l.unit.trim() !== i.unit;
            return {
              itemId: i.id,
              unitPriceKobo: parseNairaToKobo(l.price),
              quantityUnit: l.unit.trim(),
              declaredConversion:
                differs && l.factor
                  ? {
                      fromUnit: l.unit.trim(),
                      toUnit: i.unit,
                      factor: l.factor,
                      basis: 'supplier_declared',
                    }
                  : null,
              leadTimeDays: l.lead ? Number(l.lead) : null,
            };
          }),
        },
      });
      toast({ title: 'Response recorded', tone: 'success' });
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
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Record a response
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title="Record a supplier response"
          description="Prices are per the supplier's unit. A different unit needs the supplier's declared conversion (1 supplier unit = factor × RFQ unit)."
          size="lg"
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Not recorded">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Supplier account">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={supplierUserId}
                    onChange={(e) => setSupplierUserId(e.target.value)}
                  >
                    <option value="">No account (enter a name)</option>
                    {suppliers.map((s) => (
                      <option key={s.userId} value={s.userId}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              {supplierUserId ? null : (
                <Field label="Supplier name" required>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={supplierName}
                      maxLength={200}
                      onChange={(e) => setSupplierName(e.target.value)}
                    />
                  )}
                </Field>
              )}
              <Field label="Delivery charge (₦)" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={delivery}
                    onChange={(e) => setDelivery(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Valid until">
                {({ id }) => (
                  <Input
                    id={id}
                    type="date"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {items.map((i) => {
              const l = lines[i.id]!;
              const differs = l.unit.trim() !== i.unit;
              return (
                <fieldset
                  key={i.id}
                  className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-4"
                >
                  <legend className="px-1 text-xs font-medium">
                    {humanize(i.material)} · {i.specification} · {i.quantity} {i.unit}
                  </legend>
                  <Field label="Price per supplier unit (₦)" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.price}
                        onChange={(e) => update(i.id, { price: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Supplier unit" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        value={l.unit}
                        onChange={(e) => update(i.id, { unit: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label={`1 ${l.unit || 'unit'} = ? ${i.unit}`}
                    hint={
                      differs
                        ? l.factor
                          ? 'Supplier-declared conversion'
                          : 'Blank: comparison shows this line as unknown'
                        : 'Same unit'
                    }
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        inputMode="decimal"
                        disabled={!differs}
                        value={differs ? l.factor : ''}
                        onChange={(e) => update(i.id, { factor: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Lead time (days)">
                    {({ id }) => (
                      <Input
                        id={id}
                        type="number"
                        min={0}
                        value={l.lead}
                        onChange={(e) => update(i.id, { lead: e.target.value })}
                      />
                    )}
                  </Field>
                </fieldset>
              );
            })}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void submit()}>
                Record response
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

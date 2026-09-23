'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PurchaseOrderDetail } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

export interface UnconvertedLine {
  itemId: string;
  label: string;
  supplierUnit: string;
  rfqUnit: string;
}

/**
 * Purchase order from a response. Lines priced in another unit without a
 * declared factor need a staff-measured conversion first; nothing is assumed.
 */
export function CreatePurchaseOrder({
  responseId,
  supplierLabel,
  unconverted,
}: {
  responseId: string;
  supplierLabel: string;
  unconverted: UnconvertedLine[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [expected, setExpected] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [factors, setFactors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = unconverted.every(
    (u) => /^\d+(\.\d{1,6})?$/.test(factors[u.itemId] ?? '') && Number(factors[u.itemId]) > 0,
  );

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const po = await adminFetch<PurchaseOrderDetail>('/api/v1/purchase-orders', {
        body: {
          responseId,
          expectedDeliveryAt: expected ? new Date(`${expected}T12:00:00`).toISOString() : null,
          supplierRef: supplierRef.trim() || null,
          lineConversions: unconverted.map((u) => ({
            itemId: u.itemId,
            declaredConversion: {
              fromUnit: u.supplierUnit,
              toUnit: u.rfqUnit,
              factor: factors[u.itemId],
              basis: 'staff_measured',
            },
          })),
        },
      });
      toast({ title: `Purchase order ${po.number} drafted`, tone: 'success' });
      router.push(`/admin/procurement/purchase-orders/${po.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Create PO
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title={`Purchase order from ${supplierLabel}`}
          description="Created as a draft; issue it from the order page."
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Not created">
                {error}
              </Alert>
            ) : null}
            <Field label="Expected delivery date">
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              )}
            </Field>
            <Field label="Supplier reference">
              {({ id }) => (
                <Input
                  id={id}
                  value={supplierRef}
                  maxLength={120}
                  onChange={(e) => setSupplierRef(e.target.value)}
                />
              )}
            </Field>
            {unconverted.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Staff-measured conversions required</legend>
                {unconverted.map((u) => (
                  <Field
                    key={u.itemId}
                    label={`${u.label}: 1 ${u.supplierUnit} = ? ${u.rfqUnit}`}
                    required
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={factors[u.itemId] ?? ''}
                        onChange={(e) =>
                          setFactors((prev) => ({ ...prev, [u.itemId]: e.target.value }))
                        }
                      />
                    )}
                  </Field>
                ))}
              </fieldset>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ready} onClick={() => void create()}>
                Create draft PO
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

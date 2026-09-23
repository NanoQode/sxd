'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PurchaseOrderLineDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Record what physically arrived, per line, in the buyer's units. Short or damaged goods become discrepancies. */
export function RecordDelivery({
  poId,
  lines,
  outstanding,
}: {
  poId: string;
  lines: PurchaseOrderLineDto[];
  outstanding: Record<string, string>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deliveredAt, setDeliveredAt] = useState('');
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.lineId, outstanding[l.lineId] ?? ''])),
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok =
    Boolean(deliveredAt) &&
    lines.some((l) => Number(qty[l.lineId]) > 0) &&
    lines.every((l) => !qty[l.lineId] || /^\d+(\.\d{1,3})?$/.test(qty[l.lineId]!));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/purchase-orders/${poId}/deliveries`, {
        body: {
          deliveredAt: new Date(deliveredAt).toISOString(),
          lines: lines
            .filter((l) => qty[l.lineId])
            .map((l) => ({ lineId: l.lineId, quantityReceived: qty[l.lineId] })),
          evidenceFileIds: [],
          note: note.trim() || null,
        },
      });
      toast({ title: 'Delivery recorded', tone: 'success' });
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
        Record delivery
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title="Record a delivery"
          description="Quantities default to what is outstanding; change them to what was counted."
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Not recorded">
                {error}
              </Alert>
            ) : null}
            <Field label="Delivered at (your device time)" required>
              {({ id }) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={deliveredAt}
                  onChange={(e) => setDeliveredAt(e.target.value)}
                />
              )}
            </Field>
            {lines.map((l) => (
              <Field
                key={l.lineId}
                label={`${l.specification} (${l.unit}), outstanding ${outstanding[l.lineId] ?? '?'}`}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={qty[l.lineId] ?? ''}
                    onChange={(e) => setQty((prev) => ({ ...prev, [l.lineId]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Field label="Note">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-16"
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!ok} onClick={() => void submit()}>
                Record
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { invoiceKindSchema, type InvoiceDto } from '@simplexd/contracts';
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
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage, isMfaError } from '@/lib/admin/client';
import { lineProblem, percentToBps, type InvoiceLineDraft } from '@/lib/admin/invoice-lines';
import { lineAmountKobo, parseNairaToKobo, sumKobo } from '@/lib/admin/money';

type LineDraft = InvoiceLineDraft;

const EMPTY_LINE: LineDraft = {
  description: '',
  quantity: '1',
  unitNaira: '',
  taxPercent: '',
  accountCode: '',
};

/**
 * Manual invoice (milestone, management fee, other). Tax is per line and
 * explicit; nothing assumes one rate applies to every service. Totals shown
 * here are a preview; the server computes the authoritative amounts.
 */
export function InvoiceCreateDialog({
  organizations,
  defaultOrganizationId,
  defaultServiceRequestId,
  canManage,
}: {
  organizations: Array<{ id: string; name: string }>;
  defaultOrganizationId?: string;
  defaultServiceRequestId?: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState(defaultOrganizationId ?? '');
  const [kind, setKind] = useState('service');
  const [serviceRequestId, setServiceRequestId] = useState(defaultServiceRequestId ?? '');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [issue, setIssue] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  const problems = lines.map(lineProblem);
  const valid = Boolean(organizationId) && problems.every((p) => p === null);
  const subtotal = sumKobo(
    lines.map((l, i) =>
      problems[i] ? '0' : lineAmountKobo(l.quantity, parseNairaToKobo(l.unitNaira) ?? '0'),
    ),
  );
  const tax = sumKobo(
    lines.map((l, i) => {
      if (problems[i]) return '0';
      const amount = BigInt(lineAmountKobo(l.quantity, parseNairaToKobo(l.unitNaira) ?? '0'));
      const bps = BigInt(percentToBps(l.taxPercent) ?? 0);
      return ((amount * bps + 5_000n) / 10_000n).toString();
    }),
  );

  function update(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setMfa(false);
    try {
      const invoice = await adminFetch<InvoiceDto>('/api/v1/invoices', {
        body: {
          organizationId,
          kind,
          serviceRequestId: serviceRequestId.trim() || undefined,
          dueDate: dueDate || undefined,
          notes: notes.trim() || undefined,
          issue,
          lines: lines.map((l) => ({
            description: l.description.trim(),
            quantity: l.quantity,
            unitAmountKobo: parseNairaToKobo(l.unitNaira),
            taxRateBps: percentToBps(l.taxPercent) ?? 0,
            accountCode: l.accountCode || undefined,
          })),
        },
      });
      toast({
        title: issue ? `Invoice ${invoice.number} issued` : `Draft ${invoice.number} created`,
        tone: 'success',
      });
      setOpen(false);
      router.push(`/admin/finance/invoices/${invoice.id}`);
      router.refresh();
    } catch (err) {
      if (isMfaError(err)) setMfa(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>New invoice</Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title="New invoice"
          description="Manual invoice for a milestone, management fee or other agreed charge. Quote acceptance creates service invoices automatically."
          size="lg"
        >
          <div className="space-y-4">
            {error ? (
              <Alert
                tone="danger"
                title={mfa ? 'Authenticator required' : 'Could not create the invoice'}
              >
                {error}
                {mfa ? (
                  <>
                    {' '}
                    <a href="/admin/security/mfa" className="font-medium underline">
                      Verify your authenticator
                    </a>
                    .
                  </>
                ) : null}
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
              <Field label="Kind" required>
                {({ id }) => (
                  <NativeSelect id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                    {invoiceKindSchema.options.map((k) => (
                      <option key={k} value={k}>
                        {humanize(k)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field
                label="Service request id (optional)"
                hint="Links the invoice to a request of the same organisation."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={serviceRequestId}
                    onChange={(e) => setServiceRequestId(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Due date (optional)">
                {({ id }) => (
                  <Input
                    id={id}
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Lines</legend>
              {lines.map((l, i) => (
                <div
                  key={i}
                  className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[2fr_0.7fr_1fr_0.7fr_0.8fr_auto] sm:items-end"
                >
                  <Field
                    label={`Line ${i + 1} description`}
                    required
                    error={problems[i] && l.description ? problems[i] : undefined}
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        value={l.description}
                        onChange={(e) => update(i, { description: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Qty">
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => update(i, { quantity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Unit (₦)" required>
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.unitNaira}
                        onChange={(e) => update(i, { unitNaira: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Tax %">
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        placeholder="0"
                        value={l.taxPercent}
                        onChange={(e) => update(i, { taxPercent: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Account">
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="numeric"
                        placeholder="4000"
                        value={l.accountCode}
                        onChange={(e) => update(i, { accountCode: e.target.value })}
                      />
                    )}
                  </Field>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove line ${i + 1}`}
                    disabled={lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
                disabled={lines.length >= 200}
              >
                <Plus aria-hidden="true" className="h-4 w-4" /> Add line
              </Button>
            </fieldset>
            <Field label="Notes (shown on the invoice)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="min-h-16"
                  maxLength={4000}
                />
              )}
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={issue}
                onChange={(e) => setIssue(e.target.checked)}
              />
              Issue immediately (otherwise it stays a draft you can review)
            </label>
            <p className="text-sm text-fg-muted" aria-live="polite">
              Preview: subtotal {formatNairaString(subtotal)} + tax {formatNairaString(tax)} ={' '}
              <strong className="text-fg">
                {formatNairaString((BigInt(subtotal) + BigInt(tax)).toString())}
              </strong>
              . The server recomputes the totals and applies the organisation&apos;s tax treatment.
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
                {issue ? 'Create and issue' : 'Create draft'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

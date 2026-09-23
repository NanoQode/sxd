'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FileDto } from '@simplexd/contracts';
import { Alert, Button, Field, Input, useToast } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { koboToNaira } from '@/lib/portal/format';
import { ErrorState } from './error-state';
import { FileUploader } from './file-uploader';

/**
 * Declares a bank transfer (not cleared money) with the amount, the date, the
 * bank reference and an optional scanned proof. Finance confirms it against
 * the statement before the invoice moves.
 */
export function BankTransferForm({
  invoiceId,
  invoiceNumber,
  balanceKobo,
  canPay,
}: {
  invoiceId: string;
  invoiceNumber: string;
  balanceKobo: string;
  canPay: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [amountNaira, setAmountNaira] = useState(() => {
    const kobo = /^\d+$/.test(balanceKobo) ? BigInt(balanceKobo) : 0n;
    const whole = kobo / 100n;
    const frac = (kobo % 100n).toString().padStart(2, '0');
    return `${whole}.${frac}`;
  });
  const [paidAt, setPaidAt] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [proof, setProof] = useState<FileDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  function nairaToKobo(value: string): string | null {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim().replace(/,/g, ''));
    if (!m) return null;
    const whole = BigInt(m[1]!);
    const frac = BigInt((m[2] ?? '0').padEnd(2, '0'));
    return (whole * 100n + frac).toString();
  }

  async function submit() {
    const kobo = nairaToKobo(amountNaira);
    if (!kobo || kobo === '0') {
      setError({
        message: 'Enter the amount you transferred in naira, e.g. 250000.00.',
        correlationId: null,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/invoices/${invoiceId}/bank-transfer-receipts`, {
        body: {
          declaredAmountKobo: kobo,
          ...(paidAt ? { declaredPaidAt: paidAt } : {}),
          ...(bankReference.trim() ? { bankReference: bankReference.trim() } : {}),
          ...(proof ? { uploadedFileId: proof.id } : {}),
        },
      });
      toast({
        title: 'Transfer declared',
        description: 'Finance will confirm it against the bank statement.',
        tone: 'success',
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  if (!canPay) return null;
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Declare a bank transfer
      </Button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4 rounded-lg border border-border p-4"
      aria-label={`Declare a bank transfer for invoice ${invoiceNumber}`}
    >
      <Alert tone="info" title="A declaration is not a payment">
        Finance confirms the transfer against the bank statement; the invoice balance (
        {koboToNaira(balanceKobo)}) changes only then.
      </Alert>
      {error ? (
        <ErrorState
          title="Could not declare the transfer"
          message={error.message}
          correlationId={error.correlationId}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount transferred (₦)" required>
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={amountNaira}
              onChange={(e) => setAmountNaira(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Date paid">
          {({ id }) => (
            <Input id={id} type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          )}
        </Field>
        <Field
          label="Bank reference"
          hint="The narration or transaction id on your bank statement."
          className="sm:col-span-2"
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={bankReference}
              onChange={(e) => setBankReference(e.target.value)}
              maxLength={120}
            />
          )}
        </Field>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Proof of transfer (optional)</p>
        {proof ? (
          <p className="text-sm text-fg-muted">
            Attached: {proof.originalName} (
            {proof.status === 'clean' ? 'scanned clean' : proof.status.replace(/_/g, ' ')})
          </p>
        ) : (
          <FileUploader
            purpose="bank_receipt"
            multiple={false}
            compact
            label="Upload proof"
            hint="Image or PDF up to 25 MB."
            refreshOnSettle={false}
            onUploaded={(f) => setProof(f)}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          Submit declaration
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

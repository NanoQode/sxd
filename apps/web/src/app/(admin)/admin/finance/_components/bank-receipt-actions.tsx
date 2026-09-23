'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
  formatNairaString,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage, isMfaError } from '@/lib/admin/client';
import { koboToNairaInput, parseNairaToKobo } from '@/lib/admin/money';

/**
 * Confirm or reject a declared bank transfer. Finance enters the amount seen
 * on the bank statement (it may differ from the declared amount); only a
 * confirmation allocates money and issues a receipt.
 */
export function BankReceiptActions({
  receiptId,
  declaredAmountKobo,
  invoiceBalanceKobo,
  invoiceNumber,
  canReconcile,
}: {
  receiptId: string;
  declaredAmountKobo: string;
  invoiceBalanceKobo: string | null;
  invoiceNumber: string | null;
  canReconcile: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<'confirm' | 'reject' | null>(null);
  const [amount, setAmount] = useState(koboToNairaInput(declaredAmountKobo));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  if (!canReconcile)
    return <span className="text-xs text-fg-muted">Review needs finance.reconcile</span>;
  const kobo = parseNairaToKobo(amount);
  const over =
    kobo !== null && invoiceBalanceKobo !== null && BigInt(kobo) > BigInt(invoiceBalanceKobo);

  async function run() {
    setBusy(true);
    setError(null);
    setMfa(false);
    try {
      if (mode === 'confirm') {
        const res = await adminFetch<{ receiptNumber: string | null; invoiceStatus: string }>(
          `/api/v1/bank-transfer-receipts/${receiptId}/confirm`,
          { body: { confirmedAmountKobo: kobo, note: note.trim() || undefined } },
        );
        toast({
          title: 'Transfer confirmed',
          description: `Receipt ${res.receiptNumber ?? 'pending'} · invoice ${res.invoiceStatus.replace(/_/g, ' ')}`,
          tone: 'success',
        });
      } else {
        await adminFetch(`/api/v1/bank-transfer-receipts/${receiptId}/reject`, {
          body: { note: note.trim() },
        });
        toast({ title: 'Declaration rejected', tone: 'success' });
      }
      setMode(null);
      setNote('');
      router.refresh();
    } catch (err) {
      if (isMfaError(err)) setMfa(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === 'confirm' ? kobo !== null && BigInt(kobo) > 0n : note.trim().length >= 3;
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Button size="sm" variant="primary" onClick={() => setMode('confirm')}>
        Confirm
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMode('reject')}>
        Reject
      </Button>
      <Dialog open={mode !== null} onOpenChange={(v) => !busy && !v && setMode(null)}>
        <DialogContent
          title={
            mode === 'confirm'
              ? `Confirm transfer for ${invoiceNumber ?? 'invoice'}`
              : 'Reject this declaration'
          }
          description={
            mode === 'confirm'
              ? 'Enter the amount that actually arrived on the bank statement. Confirmation allocates it to the invoice, posts the journal and issues a receipt.'
              : 'The customer sees the note. Nothing is allocated.'
          }
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title={mfa ? 'Authenticator required' : 'Action failed'}>
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
            {mode === 'confirm' ? (
              <>
                <p className="text-sm">
                  Declared {formatNairaString(declaredAmountKobo)}
                  {invoiceBalanceKobo !== null
                    ? ` · invoice balance ${formatNairaString(invoiceBalanceKobo)}`
                    : ''}
                </p>
                <Field
                  label="Amount on the bank statement (₦)"
                  required
                  error={kobo === null && amount ? 'Enter a naira amount' : undefined}
                  hint={
                    over
                      ? 'More than the invoice balance: the server decides whether the excess is accepted.'
                      : undefined
                  }
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  )}
                </Field>
              </>
            ) : null}
            <Field
              label={mode === 'reject' ? 'Reason (sent to the customer)' : 'Note (optional)'}
              required={mode === 'reject'}
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-16"
                  maxLength={2000}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setMode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={mode === 'reject' ? 'danger' : 'primary'}
                loading={busy}
                disabled={!ready}
                onClick={() => void run()}
              >
                {mode === 'confirm' ? 'Confirm and allocate' : 'Reject'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

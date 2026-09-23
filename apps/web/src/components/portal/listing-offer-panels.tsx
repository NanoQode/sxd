'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ListingOfferActionName, ListingOfferDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';
import { nairaInputToKobo } from './listing-form';

type Err = { message: string; correlationId: string | null } | null;

/** Buyer form: amount, conditions, note and validity. Posts to the listing's offers endpoint. */
export function ListingOfferForm({
  listingId,
  listingTitle,
  statedPriceKobo,
}: {
  listingId: string;
  listingTitle: string;
  statedPriceKobo: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [conditions, setConditions] = useState('');
  const [note, setNote] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const kobo = nairaInputToKobo(amount);
    if (!kobo) {
      setAmountError('Enter the amount you are offering in naira, e.g. 12,500,000.');
      return;
    }
    setAmountError(null);
    setBusy(true);
    setError(null);
    try {
      const offer = await portalFetch<ListingOfferDto>(`/api/v1/listings/${listingId}/offers`, {
        body: {
          amountKobo: kobo,
          conditions: conditions
            .split('\n')
            .map((c) => c.trim())
            .filter(Boolean)
            .slice(0, 10),
          note: note.trim() || null,
          validUntil: validUntil ? new Date(validUntil).toISOString() : null,
        },
      });
      toast({ title: 'Offer submitted', tone: 'success' });
      router.push(`/portal/listings/offers/${offer.id}`);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      {error ? (
        <ErrorState
          title="Offer not submitted"
          message={error.message}
          correlationId={error.correlationId}
        />
      ) : null}
      <Alert tone="info" title="How offers work">
        Your offer goes to the owner organisation, who can accept, counter or decline. Every step is
        added to an append-only negotiation log both parties see. Acceptance is not a contract: a
        sale or lease completes through the land sales/leasing engagement with documents.
        {statedPriceKobo
          ? ` The stated price is ${formatNairaString(statedPriceKobo)}.`
          : ' No price is stated on this listing.'}
      </Alert>
      <Field
        label={`Offer for ${listingTitle} (₦)`}
        htmlFor="of-amount"
        error={amountError}
        required
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            inputMode="decimal"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Conditions (one per line, optional)"
        htmlFor="of-conditions"
        hint="For example: subject to satisfactory due diligence; vacant possession on completion."
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            rows={3}
            aria-describedby={describedBy}
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
          />
        )}
      </Field>
      <Field label="Message to the owner (optional)" htmlFor="of-note">
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            rows={3}
            aria-describedby={describedBy}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Offer valid until (optional)"
        htmlFor="of-valid"
        hint="The offer expires automatically at this time if nobody decides."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="datetime-local"
            aria-describedby={describedBy}
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" loading={busy} disabled={busy}>
        Submit offer
      </Button>
    </form>
  );
}

const ACTION_COPY: Record<
  ListingOfferActionName,
  {
    label: string;
    title: string;
    confirm: string;
    variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  }
> = {
  counter: {
    label: 'Counter',
    title: 'Counter-offer',
    confirm: 'Send counter-offer',
    variant: 'secondary',
  },
  accept: { label: 'Accept', title: 'Accept this amount?', confirm: 'Accept', variant: 'primary' },
  reject: { label: 'Decline', title: 'Decline the offer?', confirm: 'Decline', variant: 'danger' },
  withdraw: {
    label: 'Withdraw',
    title: 'Withdraw your offer?',
    confirm: 'Withdraw',
    variant: 'ghost',
  },
};

/** The party whose turn it is acts here; everything else is read-only. */
export function ListingOfferActions({ offer }: { offer: ListingOfferDto }) {
  const router = useRouter();
  const { toast } = useToast();
  const [action, setAction] = useState<ListingOfferActionName | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  if (offer.nextActions.length === 0) return null;

  async function run() {
    if (!action) return;
    const body: Record<string, unknown> = { action, expectedEntries: offer.negotiationLog.length };
    if (action === 'counter') {
      const kobo = nairaInputToKobo(amount);
      if (!kobo) {
        setError({ message: 'Enter the counter amount in naira.', correlationId: null });
        return;
      }
      body.amountKobo = kobo;
      if (validUntil) body.validUntil = new Date(validUntil).toISOString();
    }
    if (action === 'reject' && note.trim().length < 3) {
      setError({ message: 'Give a short reason for declining.', correlationId: null });
      return;
    }
    if (note.trim()) body.note = note.trim();
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/listing-offers/${offer.id}/actions`, { body });
      toast({
        title: `Offer ${ACTION_COPY[action].label.toLowerCase()}ed`
          .replace('acceptted', 'accepted')
          .replace('declineed', 'declined')
          .replace('withdrawed', 'withdrawn')
          .replace('countered', 'countered'),
        tone: 'success',
      });
      setAction(null);
      setNote('');
      setAmount('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({
        message:
          e.code === 'version_conflict' ? `${e.message} Reload to see the latest step.` : e.message,
        correlationId: e.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {offer.nextActions.map((a) => (
        <Button
          key={a}
          type="button"
          size="sm"
          variant={ACTION_COPY[a].variant}
          onClick={() => setAction(a)}
        >
          {ACTION_COPY[a].label}
        </Button>
      ))}
      <Dialog open={action !== null} onOpenChange={(v) => !busy && !v && setAction(null)}>
        <DialogContent
          title={action ? ACTION_COPY[action].title : ''}
          description={
            action === 'accept'
              ? `You accept ${formatNairaString(offer.amountKobo)}. Both parties are notified; completion is documented through the land transaction.`
              : action === 'counter'
                ? 'Your counter replaces the amount on the table; the other party can accept, counter again or end the negotiation.'
                : undefined
          }
        >
          {error ? (
            <ErrorState
              title="Not done"
              message={error.message}
              correlationId={error.correlationId}
            />
          ) : null}
          {action === 'counter' ? (
            <>
              <Field label="Counter amount (₦)" htmlFor="oa-amount" required>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    aria-describedby={describedBy}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Valid until (optional)" htmlFor="oa-valid">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    aria-describedby={describedBy}
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                )}
              </Field>
            </>
          ) : null}
          <Field
            label={action === 'reject' ? 'Reason' : 'Note (optional)'}
            htmlFor="oa-note"
            required={action === 'reject'}
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={action === 'reject' ? 'danger' : 'primary'}
              loading={busy}
              disabled={busy}
              onClick={() => void run()}
            >
              {action ? ACTION_COPY[action].confirm : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Read-only negotiation history. */
export function NegotiationLog({ offer, zone }: { offer: ListingOfferDto; zone: string }) {
  return (
    <ol className="space-y-2" aria-label="Negotiation log">
      {offer.negotiationLog.map((entry, i) => (
        <li key={`${entry.at}-${i}`} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {humanize(entry.party)} {entry.action}
              {entry.amountKobo && (entry.action === 'submitted' || entry.action === 'countered')
                ? ` at ${formatNairaString(entry.amountKobo)}`
                : ''}
            </span>
            <span className="text-xs text-fg-muted">{formatDateTimeLabel(entry.at, zone)}</span>
          </div>
          {entry.note ? (
            <p className="mt-1 whitespace-pre-wrap text-fg-muted">{entry.note}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function OfferSummaryRow({ offer, zone }: { offer: ListingOfferDto; zone: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
      <div className="min-w-0">
        <Link
          href={`/portal/listings/offers/${offer.id}`}
          className="font-medium text-primary underline"
        >
          {formatNairaString(offer.amountKobo)}
        </Link>
        <span className="text-fg-muted">
          {' '}
          ·{' '}
          {offer.viewerParty === 'buyer'
            ? `to ${offer.ownerOrganizationName ?? 'the owner'}`
            : `from ${offer.buyerOrganizationName ?? 'a buyer'}`}
          {offer.listingTitle ? ` · ${offer.listingTitle}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={offer.effectiveStatus} />
        {offer.nextActions.length > 0 ? <Badge tone="warning">Your move</Badge> : null}
        <span className="text-xs text-fg-muted">{formatDateTimeLabel(offer.updatedAt, zone)}</span>
      </div>
    </li>
  );
}

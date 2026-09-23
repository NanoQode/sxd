'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PurchaseOfferDto } from '@simplexd/contracts';
import {
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
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

/**
 * Customer-side controls for the property search and purchase tabs of a
 * request. Every control calls the versioned API and refreshes the server
 * page; failures show the correlation id. Controls that the customer's role
 * cannot use are rendered as an explanation, never as a dead button.
 */

type Err = { message: string; correlationId: string | null } | null;

function useAction() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast({ title: success, tone: 'success' });
      router.refresh();
      return true;
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

function InlineError({ error }: { error: Err }) {
  return error ? (
    <ErrorState
      title="Could not save"
      message={error.message}
      correlationId={error.correlationId}
    />
  ) : null;
}

/* ---------------------------------------------------------------------- */
/* Shortlist                                                               */
/* ---------------------------------------------------------------------- */

export function ShortlistFeedback({
  itemId,
  rating,
  feedback,
  status,
  readOnly,
}: {
  itemId: string;
  rating: number | null;
  feedback: string | null;
  status: string;
  readOnly: boolean;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [nextRating, setNextRating] = useState(rating ? String(rating) : '');
  const [text, setText] = useState(feedback ?? '');
  const [preference, setPreference] = useState<'preferred' | 'rejected' | 'candidate'>(
    status === 'preferred' || status === 'rejected' ? status : 'candidate',
  );
  if (readOnly) {
    return (
      <p className="text-xs text-fg-muted">
        {rating ? `Your rating: ${rating}/5. ` : ''}
        {feedback ? `“${feedback}”` : ''}
      </p>
    );
  }
  async function save() {
    const ok = await run(
      () =>
        portalFetch(`/api/v1/shortlist-items/${itemId}/feedback`, {
          body: {
            rating: nextRating ? Number(nextRating) : null,
            feedback: text.trim() || null,
            preference,
          },
        }),
      'Feedback saved',
    );
    if (ok) setOpen(false);
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-fg-muted">
        {rating ? `Your rating: ${rating}/5` : 'Not rated yet'}
        {feedback ? ` · “${feedback}”` : ''}
      </p>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {rating || feedback ? 'Update feedback' : 'Rate and comment'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Your view of this property" size="sm">
          <div className="space-y-3">
            <InlineError error={error} />
            <Field label="Rating" hint="1 = not for us, 5 = strong candidate">
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={nextRating}
                  onChange={(e) => setNextRating(e.target.value)}
                >
                  <option value="">No rating</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Preference">
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={preference}
                  onChange={(e) => setPreference(e.target.value as typeof preference)}
                >
                  <option value="candidate">Still considering</option>
                  <option value="preferred">Preferred</option>
                  <option value="rejected">Not for us</option>
                </NativeSelect>
              )}
            </Field>
            <Field label="Feedback for the team">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  maxLength={2000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void save()} loading={busy}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RequestViewingButton({
  serviceRequestId,
  shortlistItemId,
  disabledReason,
}: {
  serviceRequestId: string;
  shortlistItemId: string;
  disabledReason?: string;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [times, setTimes] = useState('');
  if (disabledReason) return <p className="text-xs text-fg-muted">{disabledReason}</p>;
  async function submit() {
    const ok = await run(
      () =>
        portalFetch(`/api/v1/service-requests/${serviceRequestId}/viewings`, {
          body: { shortlistItemId, preferredTimes: times.trim() || undefined },
        }),
      'Viewing requested',
    );
    if (ok) setOpen(false);
  }
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Request a viewing
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Request a viewing"
          size="sm"
          description="The team confirms a time with the seller and books it."
        >
          <div className="space-y-3">
            <InlineError error={error} />
            <Field label="Preferred times" hint="Optional: days or times that suit you.">
              {({ id }) => (
                <Input
                  id={id}
                  maxLength={500}
                  value={times}
                  onChange={(e) => setTimes(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} loading={busy}>
                Send request
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LinkViewingAppointment({
  serviceRequestId,
  appointments,
}: {
  serviceRequestId: string;
  appointments: Array<{ id: string; startsAt: string; status: string }>;
}) {
  const { busy, error, run } = useAction();
  const [appointmentId, setAppointmentId] = useState(appointments[0]?.id ?? '');
  if (appointments.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm">
        You booked{' '}
        {appointments.length === 1
          ? 'a viewing appointment'
          : `${appointments.length} viewing appointments`}{' '}
        that
        {appointments.length === 1 ? ' is' : ' are'} not yet recorded as a viewing.
      </p>
      <InlineError error={error} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Appointment">
          {({ id }) => (
            <NativeSelect
              id={id}
              value={appointmentId}
              onChange={(e) => setAppointmentId(e.target.value)}
            >
              {appointments.map((a) => (
                <option key={a.id} value={a.id}>
                  {new Date(a.startsAt).toLocaleString()} ({humanize(a.status)})
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={() =>
            void run(
              () =>
                portalFetch(`/api/v1/service-requests/${serviceRequestId}/viewings`, {
                  body: { appointmentId },
                }),
              'Viewing recorded',
            )
          }
        >
          Record as a viewing
        </Button>
      </div>
    </div>
  );
}

export function AcceptShortlistButton({
  shortlistId,
  expectedUpdatedAt,
  canAccept,
  cannotAcceptReason,
}: {
  shortlistId: string;
  expectedUpdatedAt: string;
  canAccept: boolean;
  cannotAcceptReason?: string;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  if (!canAccept) return <p className="text-sm text-fg-muted">{cannotAcceptReason}</p>;
  async function accept() {
    const ok = await run(
      () =>
        portalFetch(`/api/v1/shortlists/${shortlistId}/accept`, {
          body: { expectedUpdatedAt, note: note.trim() || undefined },
        }),
      'Shortlist accepted',
    );
    if (ok) setOpen(false);
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Accept this shortlist
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Accept the shortlist"
          size="sm"
          description="Accepting completes the search brief: the team proceeds with your preferred entries. This is recorded with your name."
        >
          <div className="space-y-3">
            <InlineError error={error} />
            <Field label="Note for the team" hint="Optional">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Not yet
              </Button>
              <Button onClick={() => void accept()} loading={busy}>
                Accept
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ViewingFeedbackForm({
  viewingId,
  expectedUpdatedAt,
  existing,
}: {
  viewingId: string;
  expectedUpdatedAt: string;
  existing: string | null;
}) {
  const { busy, error, run } = useAction();
  const [text, setText] = useState(existing ?? '');
  const [editing, setEditing] = useState(!existing);
  if (!editing) {
    return (
      <div className="text-xs text-fg-muted">
        “{existing}”{' '}
        <button type="button" className="underline" onClick={() => setEditing(true)}>
          edit
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <InlineError error={error} />
      <Field label="How was the viewing?">
        {({ id }) => (
          <Textarea
            id={id}
            rows={2}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={text.trim().length < 3}
        onClick={() =>
          void run(
            () =>
              portalFetch(`/api/v1/viewings/${viewingId}/feedback`, {
                body: { feedback: text.trim(), expectedUpdatedAt },
              }),
            'Feedback saved',
          ).then((ok) => ok && setEditing(false))
        }
      >
        Save feedback
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Offers                                                                  */
/* ---------------------------------------------------------------------- */

const ACTION_LABELS: Record<string, string> = {
  submit: 'Submit to the seller',
  revise: 'Revise the offer',
  accept: "Accept the seller's counter",
  withdraw: 'Withdraw',
  note: 'Add a note',
  counter: 'Record counter-offer',
  reject: 'Record rejection',
  expire: 'Mark expired',
};

function nairaToKobo(input: string): string | null {
  const cleaned = input.replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return `${whole}${frac.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}

export function OfferComposer({
  serviceRequestId,
  entries,
  disabledReason,
}: {
  serviceRequestId: string;
  entries: Array<{ id: string; title: string }>;
  disabledReason?: string;
}) {
  const { busy, error, run, setError } = useAction();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState(entries[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [terms, setTerms] = useState('');
  const [note, setNote] = useState('');
  if (disabledReason) return <p className="text-sm text-fg-muted">{disabledReason}</p>;
  if (entries.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        An offer is drafted on a shortlisted property; ask the team to shortlist one first.
      </p>
    );
  }
  async function submit() {
    const kobo = nairaToKobo(amount);
    if (!kobo || kobo === '0') {
      setError({ message: 'Enter the offer amount in naira.', correlationId: null });
      return;
    }
    const ok = await run(
      () =>
        portalFetch(`/api/v1/service-requests/${serviceRequestId}/purchase/offers`, {
          body: {
            shortlistItemId: entry,
            amountKobo: kobo,
            conditions: terms
              .split('\n')
              .map((t) => t.trim())
              .filter((t) => t.length >= 2),
            note: note.trim() || undefined,
          },
        }),
      'Offer drafted',
    );
    if (ok) setOpen(false);
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Draft an offer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Draft an offer"
          description="A draft is not sent anywhere until you submit it."
          size="md"
        >
          <div className="space-y-3">
            <InlineError error={error} />
            <Field label="Property">
              {({ id }) => (
                <NativeSelect id={id} value={entry} onChange={(e) => setEntry(e.target.value)}>
                  {entries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Offer amount (₦)" required>
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Terms"
              hint="One per line, e.g. “Subject to survey”. Accepted terms become tracked conditions."
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
              )}
            </Field>
            <Field label="Note" hint="Optional; recorded in the negotiation log.">
              {({ id }) => (
                <Input
                  id={id}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} loading={busy}>
                Save draft
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OfferActions({
  offer,
  canCommit,
  cannotCommitReason,
  staff = false,
}: {
  offer: Pick<PurchaseOfferDto, 'id' | 'status' | 'entries' | 'availableActions' | 'amountKobo'>;
  canCommit: boolean;
  cannotCommitReason?: string;
  /** Staff variant: the seller's response actions are offered and instructions are required. */
  staff?: boolean;
}) {
  const { busy, error, run, setError } = useAction();
  const [action, setAction] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const commits = (a: string) => ['submit', 'revise', 'accept', 'withdraw'].includes(a);
  const sellerSide = (a: string) => ['counter', 'reject', 'expire'].includes(a);
  const actions = offer.availableActions.filter((a) => (staff ? true : !sellerSide(a.action)));
  if (actions.length === 0) return null;
  const rule = actions.find((a) => a.action === action);
  const needsAmount = action === 'counter' || action === 'revise';
  const needsNote = Boolean(rule?.reasonRequired) || (staff && commits(action ?? ''));
  async function submit() {
    if (!action) return;
    const kobo = needsAmount ? nairaToKobo(amount) : undefined;
    if (needsAmount && (!kobo || kobo === '0')) {
      setError({ message: 'Enter the amount in naira.', correlationId: null });
      return;
    }
    if (needsNote && note.trim().length < 3) {
      setError({
        message:
          staff && commits(action)
            ? "Record the customer's instruction (how and when they asked for this)."
            : 'A short reason is required; it is recorded in the negotiation log.',
        correlationId: null,
      });
      return;
    }
    const ok = await run(
      () =>
        portalFetch(`/api/v1/purchase-offers/${offer.id}/actions`, {
          body: {
            action,
            amountKobo: kobo,
            note: note.trim() || undefined,
            expectedEntries: offer.entries,
          },
        }),
      `Offer ${ACTION_LABELS[action]?.toLowerCase() ?? action}`,
    );
    if (ok) {
      setAction(null);
      setAmount('');
      setNote('');
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const blocked = !staff && commits(a.action) && !canCommit;
          return (
            <Button
              key={a.action}
              size="sm"
              variant={
                a.action === 'withdraw' || a.action === 'reject'
                  ? 'danger'
                  : a.action === 'note'
                    ? 'ghost'
                    : 'secondary'
              }
              disabled={blocked}
              title={blocked ? cannotCommitReason : undefined}
              onClick={() => {
                setError(null);
                setAction(a.action);
              }}
            >
              {ACTION_LABELS[a.action] ?? humanize(a.action)}
            </Button>
          );
        })}
      </div>
      {!staff && !canCommit && actions.some((a) => commits(a.action)) ? (
        <p className="text-xs text-fg-muted">{cannotCommitReason}</p>
      ) : null}
      <Dialog open={action !== null} onOpenChange={(o) => !o && setAction(null)}>
        {action ? (
          <DialogContent title={ACTION_LABELS[action] ?? humanize(action)} size="sm">
            <div className="space-y-3">
              <InlineError error={error} />
              {needsAmount ? (
                <Field label="Amount (₦)" required>
                  {({ id }) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  )}
                </Field>
              ) : null}
              <Field
                label={staff && commits(action) ? "Customer's instruction" : 'Note'}
                required={needsNote}
                hint="Recorded in the append-only negotiation log."
              >
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setAction(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void submit()}
                  loading={busy}
                  variant={action === 'withdraw' || action === 'reject' ? 'danger' : 'primary'}
                >
                  Confirm
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Handover                                                                */
/* ---------------------------------------------------------------------- */

export function AcknowledgeHandoverButton({
  itemId,
  expectedVersion,
  disabledReason,
}: {
  itemId: string;
  expectedVersion: number;
  disabledReason?: string;
}) {
  const { busy, error, run } = useAction();
  if (disabledReason) return <p className="text-xs text-fg-muted">{disabledReason}</p>;
  return (
    <div className="space-y-1">
      <InlineError error={error} />
      <Button
        size="sm"
        loading={busy}
        onClick={() =>
          void run(
            () =>
              portalFetch(`/api/v1/purchase-items/${itemId}/acknowledge`, {
                body: { expectedVersion },
              }),
            'Receipt acknowledged',
          )
        }
      >
        Acknowledge receipt
      </Button>
    </div>
  );
}

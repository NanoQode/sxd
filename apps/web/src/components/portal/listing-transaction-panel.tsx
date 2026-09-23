'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type {
  FileDto,
  LeaseMilestoneDto,
  LeaseMilestoneStatus,
  ListingDetailDto,
  ListingOutcomeKind,
  ListingTransactionDto,
} from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateLabel,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

type Err = { message: string; correlationId: string | null } | null;

const MILESTONE_STATUSES: LeaseMilestoneStatus[] = [
  'open',
  'in_progress',
  'satisfied',
  'waived',
  'failed',
  'cancelled',
];

/**
 * Land transaction tracking for one listing: the linked service request,
 * milestones (lease milestones or closing tasks) and the documented outcome.
 * Everything posts to the listing transaction endpoints; the server checks
 * the permission, the request eligibility and the item versions.
 */
export function ListingTransactionPanel({
  listing,
  transaction,
  files,
  canManage,
  zone,
}: {
  listing: ListingDetailDto;
  transaction: ListingTransactionDto;
  /** Files of the property the outcome evidence can be chosen from. */
  files: FileDto[];
  canManage: boolean;
  zone: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LeaseMilestoneDto | null>(null);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [form, setForm] = useState({
    serviceRequestId: '',
    title: '',
    detail: '',
    reference: '',
    dueAt: '',
  });
  const [edit, setEdit] = useState<{
    status: LeaseMilestoneStatus;
    note: string;
    fileIds: string[];
  }>({ status: 'open', note: '', fileIds: [] });
  const [outcome, setOutcome] = useState<{
    outcome: ListingOutcomeKind;
    serviceRequestId: string;
    note: string;
    fileIds: string[];
    offerId: string;
  }>({
    outcome: listing.kind === 'lease' ? 'leased' : 'sold',
    serviceRequestId: '',
    note: '',
    fileIds: [],
    offerId: transaction.acceptedOffer?.id ?? '',
  });

  const linked = transaction.serviceRequest;
  const needsRequest = !linked;
  const usable = files.filter(
    (f) => f.status === 'clean' || f.status === 'uploaded' || f.status === 'scanning',
  );
  const milestoneWord = listing.kind === 'sale' ? 'closing task' : 'lease milestone';

  async function call(
    path: string,
    body: unknown,
    method: 'POST' | 'PATCH',
    success: string,
    done: () => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      await portalFetch(path, { method, body });
      toast({ title: success, tone: 'success' });
      done();
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  function addMilestone(event: FormEvent) {
    event.preventDefault();
    if (form.title.trim().length < 3) {
      setError({ message: 'Give the milestone a title.', correlationId: null });
      return;
    }
    if (needsRequest && !form.serviceRequestId) {
      setError({
        message: 'Choose the land sales/leasing request this transaction runs under.',
        correlationId: null,
      });
      return;
    }
    void call(
      `/api/v1/listings/${listing.id}/lease-milestones`,
      {
        ...(needsRequest ? { serviceRequestId: form.serviceRequestId } : {}),
        title: form.title.trim(),
        detail: form.detail.trim() || null,
        reference: form.reference.trim() || null,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
      },
      'POST',
      'Milestone added',
      () => {
        setAdding(false);
        setForm({ serviceRequestId: '', title: '', detail: '', reference: '', dueAt: '' });
      },
    );
  }

  function saveMilestone() {
    if (!editing) return;
    void call(
      `/api/v1/listings/${listing.id}/lease-milestones/${editing.id}`,
      {
        expectedVersion: editing.version,
        status: edit.status,
        resolutionNote: edit.note.trim() || null,
        fileIds: edit.fileIds,
      },
      'PATCH',
      'Milestone updated',
      () => setEditing(null),
    );
  }

  function recordOutcome(event: FormEvent) {
    event.preventDefault();
    if (outcome.note.trim().length < 3) {
      setError({ message: 'Describe the outcome in a short note.', correlationId: null });
      return;
    }
    void call(
      `/api/v1/listings/${listing.id}/outcome`,
      {
        expectedVersion: listing.version,
        outcome: outcome.outcome,
        ...(needsRequest && outcome.serviceRequestId
          ? { serviceRequestId: outcome.serviceRequestId }
          : {}),
        offerId: outcome.offerId || null,
        fileIds: outcome.fileIds,
        note: outcome.note.trim(),
      },
      'POST',
      'Outcome recorded',
      () => setOutcomeOpen(false),
    );
  }

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const requestSelect = (value: string, onChange: (v: string) => void, idPrefix: string) => (
    <Field
      label="Land sales/leasing request"
      htmlFor={`${idPrefix}-sr`}
      hint="The engagement that represents this transaction; every milestone and the outcome attach to it."
      required
    >
      {({ id, describedBy }) => (
        <NativeSelect
          id={id}
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose a request</option>
          {transaction.eligibleRequests.map((r) => (
            <option key={r.id} value={r.id}>
              {r.reference} · {r.title} ({humanize(r.status)})
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );

  const fileChecklist = (selected: string[], onToggle: (id: string) => void, idPrefix: string) => (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Evidence files</legend>
      {usable.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No usable files on the property yet. Upload the agreement or receipt from the
          property&apos;s Documents tab first.
        </p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {usable.map((f) => (
            <li key={f.id} className="flex items-start gap-2 text-sm">
              <input
                id={`${idPrefix}-${f.id}`}
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={selected.includes(f.id)}
                onChange={() => onToggle(f.id)}
              />
              <label htmlFor={`${idPrefix}-${f.id}`} className="break-all">
                {f.originalName}{' '}
                <span className="text-xs text-fg-muted">({humanize(f.status)})</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );

  return (
    <div className="space-y-6">
      {error ? (
        <ErrorState title="Not saved" message={error.message} correlationId={error.correlationId} />
      ) : null}
      <section className="rounded-lg border border-border bg-bg-elevated p-4">
        <h3 className="text-base font-semibold">Transaction request</h3>
        {linked ? (
          <p className="mt-1 text-sm">
            Tracked on{' '}
            <Link href={`/portal/requests/${linked.id}`} className="text-primary underline">
              {linked.reference}
            </Link>{' '}
            · {linked.title} · <StatusBadge status={linked.status} />
          </p>
        ) : transaction.eligibleRequests.length > 0 ? (
          <p className="mt-1 text-sm text-fg-muted">
            Not linked yet. The first milestone or the outcome names one of your open land
            sales/leasing requests.
          </p>
        ) : (
          <div className="mt-1 text-sm text-fg-muted">
            <p>
              No open land sales/leasing request exists for your organisation, so milestones and the
              outcome cannot be recorded yet.
            </p>
            {canManage ? (
              <Link
                href="/portal/requests/new?service=land-sales-leasing"
                className="mt-2 inline-block text-primary underline"
              >
                Request the land sales/leasing service
              </Link>
            ) : null}
          </div>
        )}
        {transaction.acceptedOffer ? (
          <p className="mt-2 text-sm">
            Accepted offer: {formatNairaString(transaction.acceptedOffer.amountKobo)}
            {transaction.acceptedOffer.decidedAt
              ? ` on ${formatDateLabel(transaction.acceptedOffer.decidedAt, zone)}`
              : ''}
            .
          </p>
        ) : null}
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">
            {listing.kind === 'sale' ? 'Closing tasks' : 'Lease milestones'}
          </h3>
          {canManage &&
          listing.status !== 'archived' &&
          (linked || transaction.eligibleRequests.length > 0) ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(true)}>
              Add {milestoneWord}
            </Button>
          ) : null}
        </div>
        {transaction.milestones.length === 0 ? (
          <EmptyState
            title={`No ${milestoneWord}s yet`}
            description="Deposit, execution of the agreement, consent, handover: each step is recorded with a due date, a status and evidence."
            className="mt-3"
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {transaction.milestones.map((m) => (
              <li key={m.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{m.title}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={m.status} />
                    {canManage && listing.status !== 'archived' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(m);
                          setEdit({
                            status: m.status,
                            note: m.resolutionNote ?? '',
                            fileIds: m.fileIds,
                          });
                        }}
                      >
                        Update
                      </Button>
                    ) : null}
                  </span>
                </div>
                <p className="text-xs text-fg-muted">
                  {m.dueAt ? `Due ${formatDateLabel(m.dueAt, zone)}` : 'No due date'}
                  {m.reference ? ` · ref ${m.reference}` : ''}
                  {m.resolvedAt ? ` · resolved ${formatDateTimeLabel(m.resolvedAt, zone)}` : ''}
                  {m.fileIds.length > 0
                    ? ` · ${m.fileIds.length} file${m.fileIds.length === 1 ? '' : 's'}`
                    : ''}
                </p>
                {m.detail ? <p className="mt-1 whitespace-pre-wrap">{m.detail}</p> : null}
                {m.resolutionNote ? <p className="mt-1 text-fg-muted">{m.resolutionNote}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-bg-elevated p-4">
        <h3 className="text-base font-semibold">Outcome</h3>
        {transaction.outcome ? (
          <div className="mt-1 text-sm">
            <p>
              <StatusBadge status="completed" label={humanize(transaction.outcome.outcome)} />{' '}
              recorded {formatDateTimeLabel(transaction.outcome.recordedAt, zone)} with{' '}
              {transaction.outcome.fileIds.length} evidence file
              {transaction.outcome.fileIds.length === 1 ? '' : 's'}.
            </p>
            {transaction.outcome.note ? (
              <p className="mt-1 whitespace-pre-wrap text-fg-muted">{transaction.outcome.note}</p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-fg-muted">
              Completion evidence for the land sales/leasing service is the authorised listing plus
              this documented outcome: sold or leased with the executed agreement, or withdrawn with
              a reason.
            </p>
            {canManage && listing.status !== 'archived' ? (
              <Button type="button" size="sm" className="mt-3" onClick={() => setOutcomeOpen(true)}>
                Record outcome
              </Button>
            ) : null}
          </>
        )}
      </section>

      <Dialog open={adding} onOpenChange={(v) => !busy && setAdding(v)}>
        <DialogContent title={`Add ${milestoneWord}`} size="lg">
          <form onSubmit={addMilestone} className="space-y-4" noValidate>
            {needsRequest
              ? requestSelect(
                  form.serviceRequestId,
                  (v) => setForm((p) => ({ ...p, serviceRequestId: v })),
                  'ms',
                )
              : null}
            <Field label="Title" htmlFor="ms-title" required>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                />
              )}
            </Field>
            <Field label="Detail (optional)" htmlFor="ms-detail">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  value={form.detail}
                  onChange={(e) => setForm((p) => ({ ...p, detail: e.target.value }))}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Reference (optional)"
                htmlFor="ms-ref"
                hint="Deed, consent or receipt number."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={form.reference}
                    onChange={(e) => setForm((p) => ({ ...p, reference: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Due (optional)" htmlFor="ms-due">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    aria-describedby={describedBy}
                    value={form.dueAt}
                    onChange={(e) => setForm((p) => ({ ...p, dueAt: e.target.value }))}
                  />
                )}
              </Field>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAdding(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={busy}>
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(v) => !busy && !v && setEditing(null)}>
        <DialogContent title={editing ? `Update: ${editing.title}` : ''} size="lg">
          <div className="space-y-4">
            <Field label="Status" htmlFor="me-status" required>
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={edit.status}
                  onChange={(e) =>
                    setEdit((p) => ({ ...p, status: e.target.value as LeaseMilestoneStatus }))
                  }
                >
                  {MILESTONE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field
              label="Note"
              htmlFor="me-note"
              hint="Required when waiving, failing or cancelling."
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  value={edit.note}
                  onChange={(e) => setEdit((p) => ({ ...p, note: e.target.value }))}
                />
              )}
            </Field>
            {fileChecklist(
              edit.fileIds,
              (fid) => setEdit((p) => ({ ...p, fileIds: toggle(p.fileIds, fid) })),
              'me-file',
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="button" loading={busy} disabled={busy} onClick={saveMilestone}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={outcomeOpen} onOpenChange={(v) => !busy && setOutcomeOpen(v)}>
        <DialogContent
          title="Record the outcome"
          description="Sold and leased close the listing and need evidence; withdrawn takes the listing off the market."
          size="lg"
        >
          <form onSubmit={recordOutcome} className="space-y-4" noValidate>
            <Field label="Outcome" htmlFor="oc-kind" required>
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={outcome.outcome}
                  onChange={(e) =>
                    setOutcome((p) => ({ ...p, outcome: e.target.value as ListingOutcomeKind }))
                  }
                >
                  <option value="sold">Sold</option>
                  <option value="leased">Leased</option>
                  <option value="withdrawn">Withdrawn</option>
                </NativeSelect>
              )}
            </Field>
            {needsRequest && transaction.eligibleRequests.length > 0
              ? requestSelect(
                  outcome.serviceRequestId,
                  (v) => setOutcome((p) => ({ ...p, serviceRequestId: v })),
                  'oc',
                )
              : null}
            {needsRequest &&
            transaction.eligibleRequests.length === 0 &&
            outcome.outcome !== 'withdrawn' ? (
              <Alert tone="warning" title="No land sales/leasing request">
                A sold or leased outcome must be recorded on a land sales/leasing request. Request
                the service first, or record a withdrawal.
              </Alert>
            ) : null}
            {transaction.acceptedOffer ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={outcome.offerId === transaction.acceptedOffer.id}
                  onChange={(e) =>
                    setOutcome((p) => ({
                      ...p,
                      offerId: e.target.checked ? transaction.acceptedOffer!.id : '',
                    }))
                  }
                />
                Completed on the accepted offer of{' '}
                {formatNairaString(transaction.acceptedOffer.amountKobo)}
              </label>
            ) : null}
            <Field
              label="Note"
              htmlFor="oc-note"
              hint="What was agreed, with whom (organisation, not personal details) and when."
              required
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  value={outcome.note}
                  onChange={(e) => setOutcome((p) => ({ ...p, note: e.target.value }))}
                />
              )}
            </Field>
            {outcome.outcome !== 'withdrawn'
              ? fileChecklist(
                  outcome.fileIds,
                  (fid) => setOutcome((p) => ({ ...p, fileIds: toggle(p.fileIds, fid) })),
                  'oc-file',
                )
              : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOutcomeOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={busy}>
                Record
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

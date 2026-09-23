'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { BidDto, BidReadDto, BidRevisionInput, TenderDetail } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  PageHeader,
  StatusBadge,
  Textarea,
  formatNairaString,
  useToast,
} from '@simplexd/ui';
import { ApiClientError, errorMessage } from '@/lib/api/client-fetch';
import { isApiCode, partnerFetch, serverNow, useServerNow } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { koboToNairaInput, multiplyKobo, nairaInputToKobo, sumKobo } from '@/lib/partner/money';
import { uploadFile } from '@/lib/partner/upload';
import { DeadlineCountdown, DualTime, LoadingBlock, NotAvailable, RequestFailed } from '../common';

interface LineForm {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  rateNaira: string;
  amountNaira: string;
}

interface BidForm {
  lines: LineForm[];
  amountNaira: string;
  amountManual: boolean;
  durationDays: string;
  statement: string;
  experienceYears: string;
  teamSize: string;
  attachmentFileIds: string[];
}

function newLine(): LineForm {
  return {
    id: Math.random().toString(36).slice(2),
    description: '',
    quantity: '',
    unit: '',
    rateNaira: '',
    amountNaira: '',
  };
}

function emptyForm(): BidForm {
  return {
    lines: [],
    amountNaira: '',
    amountManual: false,
    durationDays: '',
    statement: '',
    experienceYears: '',
    teamSize: '',
    attachmentFileIds: [],
  };
}

function formFromBid(bid: BidDto): BidForm {
  const rev = bid.latestRevision;
  if (!rev) return emptyForm();
  const q = rev.qualifications as Record<string, unknown>;
  const lines = rev.lineItems.map((l) => ({
    id: Math.random().toString(36).slice(2),
    description: l.description,
    quantity: l.quantity ?? '',
    unit: l.unit ?? '',
    rateNaira: koboToNairaInput(l.rateKobo ?? null),
    amountNaira: koboToNairaInput(l.amountKobo),
  }));
  const linesSum = sumKobo(rev.lineItems.map((l) => l.amountKobo));
  return {
    lines,
    amountNaira: koboToNairaInput(rev.amountKobo),
    amountManual: lines.length > 0 && linesSum !== rev.amountKobo,
    durationDays: rev.durationDays?.toString() ?? '',
    statement: typeof q.statement === 'string' ? q.statement : '',
    experienceYears: typeof q.experienceYears === 'number' ? String(q.experienceYears) : '',
    teamSize: typeof q.teamSize === 'number' ? String(q.teamSize) : '',
    attachmentFileIds: rev.attachmentFileIds,
  };
}

function validate(form: BidForm): {
  input: BidRevisionInput | null;
  errors: Array<{ id: string; message: string }>;
} {
  const errors: Array<{ id: string; message: string }> = [];
  const lineItems: BidRevisionInput['lineItems'] = [];
  form.lines.forEach((l, i) => {
    if (!l.description.trim())
      errors.push({
        id: `line-${l.id}-description`,
        message: `Line ${i + 1}: description is required`,
      });
    const amount = nairaInputToKobo(l.amountNaira);
    if (amount === null)
      errors.push({
        id: `line-${l.id}-amount`,
        message: `Line ${i + 1}: enter the amount in naira (up to two decimals)`,
      });
    const rate = l.rateNaira.trim() ? nairaInputToKobo(l.rateNaira) : null;
    if (l.rateNaira.trim() && rate === null)
      errors.push({
        id: `line-${l.id}-rate`,
        message: `Line ${i + 1}: rate must be a naira amount`,
      });
    if (l.quantity.trim() && !/^\d+(\.\d+)?$/.test(l.quantity.trim()))
      errors.push({
        id: `line-${l.id}-quantity`,
        message: `Line ${i + 1}: quantity must be a number`,
      });
    if (amount !== null) {
      lineItems.push({
        description: l.description.trim(),
        quantity: l.quantity.trim() || null,
        unit: l.unit.trim() || null,
        rateKobo: rate,
        amountKobo: amount,
      });
    }
  });
  const amountKobo = nairaInputToKobo(form.amountNaira);
  if (amountKobo === null || amountKobo === '0')
    errors.push({ id: 'bid-amount', message: 'Enter the total bid amount in naira' });
  const duration = form.durationDays.trim() ? Number(form.durationDays) : null;
  if (duration !== null && (!Number.isInteger(duration) || duration <= 0 || duration > 3650))
    errors.push({
      id: 'bid-duration',
      message: 'Duration must be a whole number of days (1–3650)',
    });
  const years = form.experienceYears.trim() ? Number(form.experienceYears) : null;
  if (years !== null && (!Number.isFinite(years) || years < 0))
    errors.push({ id: 'bid-years', message: 'Years of experience must be a number' });
  const team = form.teamSize.trim() ? Number(form.teamSize) : null;
  if (team !== null && (!Number.isInteger(team) || team < 0))
    errors.push({ id: 'bid-team', message: 'Team size must be a whole number' });
  if (errors.length > 0 || amountKobo === null) return { input: null, errors };
  const qualifications: Record<string, unknown> = {};
  if (form.statement.trim()) qualifications.statement = form.statement.trim();
  if (years !== null) qualifications.experienceYears = years;
  if (team !== null) qualifications.teamSize = team;
  return {
    input: {
      amountKobo,
      currency: 'NGN',
      lineItems,
      durationDays: duration,
      qualifications,
      attachmentFileIds: form.attachmentFileIds,
    },
    errors,
  };
}

const AUTOSAVE_PREFIX = 'sxd-bid-draft:';

export function BidWorkspace({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { now, known } = useServerNow();
  const tender = useQuery({
    queryKey: ['partner', 'tender', tenderId],
    queryFn: () => partnerFetch<TenderDetail>(`/api/v1/tenders/${tenderId}`),
  });
  const bidId = tender.data?.myBid?.id ?? null;
  const bid = useQuery({
    queryKey: ['partner', 'bid', bidId],
    queryFn: () => partnerFetch<BidReadDto>(`/api/v1/bids/${bidId}`),
    enabled: bidId !== null,
  });
  const fullBid = bid.data && bid.data.sealed === false ? (bid.data as BidDto) : null;
  const startBid = useMutation({
    mutationFn: () => partnerFetch<BidDto>(`/api/v1/tenders/${tenderId}/bids`, { body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] }),
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not start a bid', description: errorMessage(err) }),
  });
  if (tender.isPending) return <LoadingBlock rows={5} label="Loading tender" />;
  if (tender.isError)
    return (
      <RequestFailed error={tender.error} onRetry={() => void tender.refetch()} context="Tender" />
    );
  const t = tender.data;
  const deadline = t.timeline.effectiveSubmissionDeadlineAt;
  const deadlinePassed = deadline ? new Date(deadline).getTime() <= now.getTime() : true;
  const tenderOpen = ['published', 'clarifications'].includes(t.status);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/partner/tenders/${t.id}`} className="underline">
            {t.reference} · {t.title}
          </Link>
        }
        title="Bid workspace"
        description="Build your bid in revisions, then submit before the deadline. The deadline is enforced on the server clock inside the submission; a late submit fails with deadline_passed and nothing changes."
        actions={<DeadlineCountdown deadlineIso={deadline} />}
      />
      {t.myInvitation?.status === 'declined' ? (
        <Alert tone="warning" title="You declined this invitation">
          The bid workspace is closed for declined invitations.
        </Alert>
      ) : !bidId ? (
        <Card>
          <CardContent className="space-y-3 pt-5 text-sm">
            <p>No bid exists yet. Starting one creates a private draft that only you can see.</p>
            {tenderOpen && !deadlinePassed ? (
              <Button onClick={() => startBid.mutate()} loading={startBid.isPending}>
                Start a bid
              </Button>
            ) : (
              <Alert tone="info" title={deadlinePassed ? 'Deadline passed' : 'Tender not open'}>
                {deadlinePassed
                  ? 'The submission deadline has passed; no new bids can be started.'
                  : `The tender is ${t.status}; bids cannot be started.`}
              </Alert>
            )}
          </CardContent>
        </Card>
      ) : bid.isPending ? (
        <LoadingBlock rows={4} label="Loading bid" />
      ) : bid.isError ? (
        <RequestFailed error={bid.error} onRetry={() => void bid.refetch()} context="Bid" />
      ) : !fullBid ? (
        <Alert tone="info" title="Sealed">
          The server returned only a sealed summary for this bid, which happens when it is not
          yours.
        </Alert>
      ) : (
        <BidEditor
          key={`${fullBid.id}:${fullBid.version}`}
          tender={t}
          bid={fullBid}
          deadlinePassed={deadlinePassed}
          tenderOpen={tenderOpen}
          known={known}
        />
      )}
    </div>
  );
}

function loadAutosave(key: string, bidVersion: number): BidForm | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { form: BidForm; bidVersion: number };
    return saved.bidVersion === bidVersion ? saved.form : null;
  } catch {
    return null;
  }
}

/** Keyed on bid id + version so a server change re-seeds the form. */
function BidEditor({
  tender: t,
  bid: fullBid,
  deadlinePassed,
  tenderOpen,
  known,
}: {
  tender: TenderDetail;
  bid: BidDto;
  deadlinePassed: boolean;
  tenderOpen: boolean;
  known: boolean;
}) {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const tenderId = t.id;
  const bidId = fullBid.id;
  const autosaveKey = `${AUTOSAVE_PREFIX}${p.userId}:${tenderId}`;
  const [seededFromTab] = useState(() => loadAutosave(autosaveKey, fullBid.version));
  const [form, setForm] = useState<BidForm>(() => seededFromTab ?? formFromBid(fullBid));
  const [dirty, setDirty] = useState(() => seededFromTab !== null);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saved' | 'unavailable'>(() =>
    seededFromTab ? 'saved' : 'idle',
  );
  const [errors, setErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);

  // Tab-local autosave with visible status.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(
          autosaveKey,
          JSON.stringify({ at: new Date().toISOString(), form, bidVersion: fullBid.version }),
        );
        setAutosaveState('saved');
      } catch {
        setAutosaveState('unavailable');
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [form, dirty, fullBid.version, autosaveKey]);

  const saveRevision = useMutation({
    mutationFn: (input: BidRevisionInput) =>
      partnerFetch<BidDto>(`/api/v1/bids/${bidId}/revisions`, { body: input }),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Revision saved',
        description:
          'Saved as an unsubmitted revision. Submit before the deadline to make it count.',
      });
      clearAutosave();
      void qc.invalidateQueries({ queryKey: ['partner', 'bid', bidId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'bids'] });
    },
  });
  const submit = useMutation({
    mutationFn: (input: BidRevisionInput) =>
      partnerFetch<BidDto>(`/api/v1/bids/${bidId}/submit`, {
        body: {
          revision: input,
          clientClaimedTime: serverNow().toISOString(),
          expectedVersion: fullBid.version,
        },
      }),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Bid submitted',
        description: 'Your submission is sealed until staff open bids after the deadline.',
      });
      clearAutosave();
      void qc.invalidateQueries({ queryKey: ['partner', 'bid', bidId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'bids'] });
      void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] });
    },
  });
  const withdraw = useMutation({
    mutationFn: () =>
      partnerFetch<BidDto>(`/api/v1/bids/${bidId}/withdraw`, {
        body: { reason: withdrawReason.trim(), expectedVersion: fullBid.version },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Bid withdrawn' });
      setWithdrawOpen(false);
      void qc.invalidateQueries({ queryKey: ['partner', 'bid', bidId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'bids'] });
      void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] });
    },
  });

  function clearAutosave() {
    try {
      sessionStorage.removeItem(autosaveKey);
    } catch {
      /* ignore */
    }
    setDirty(false);
    setAutosaveState('idle');
  }

  const linesTotalKobo = useMemo(
    () => sumKobo(form.lines.map((l) => nairaInputToKobo(l.amountNaira))),
    [form.lines],
  );

  function update(patch: Partial<BidForm>) {
    setForm((f) => {
      const next = { ...f, ...patch };
      if (!next.amountManual && next.lines.length > 0) {
        next.amountNaira = koboToNairaInput(
          sumKobo(next.lines.map((l) => nairaInputToKobo(l.amountNaira))),
        );
      }
      return next;
    });
    setDirty(true);
  }

  function updateLine(id: string, patch: Partial<LineForm>) {
    setForm((f) => {
      const lines = f.lines.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...patch };
        if (
          ('rateNaira' in patch || 'quantity' in patch) &&
          next.rateNaira.trim() &&
          next.quantity.trim()
        ) {
          const rate = nairaInputToKobo(next.rateNaira);
          const product = rate ? multiplyKobo(rate, next.quantity.trim()) : null;
          if (product) next.amountNaira = koboToNairaInput(product);
        }
        return next;
      });
      const next = { ...f, lines };
      if (!next.amountManual)
        next.amountNaira = koboToNairaInput(
          sumKobo(lines.map((l) => nairaInputToKobo(l.amountNaira))),
        );
      return next;
    });
    setDirty(true);
  }

  async function addAttachment(file: File) {
    setUploading(true);
    setUploadProblem(null);
    try {
      const res = await uploadFile(file, { purpose: 'org_document' });
      if (res.outcome === 'rejected') {
        setUploadProblem(res.file.statusReason ?? 'the file was rejected');
        return;
      }
      update({ attachmentFileIds: [...form.attachmentFileIds, res.file.id] });
      toast({
        tone: 'success',
        title: 'Attachment uploaded',
        description: 'It is being scanned; the bid can reference it once the scan passes.',
      });
    } catch (err) {
      setUploadProblem(
        err instanceof ApiClientError &&
          (err.code === 'forbidden' || err.code === 'validation_failed')
          ? `The upload API has no purpose for partner bid attachments outside a customer organisation (server said: ${err.message}). This is a known API gap; send documents to staff through Messages until it is added.`
          : errorMessage(err),
      );
    } finally {
      setUploading(false);
    }
  }

  // Withdrawn, disqualified, evaluated and later states are terminal for the bidder.
  const canEdit = tenderOpen && !deadlinePassed && ['draft', 'submitted'].includes(fullBid.status);
  const deadlineError = submit.isError && isApiCode(submit.error, 'deadline_passed');

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={fullBid.status} />
        <span className="text-fg-muted">
          Revision {fullBid.currentVersion} of {fullBid.revisions.length}
          {fullBid.submittedAt ? (
            <>
              {' '}
              · submitted <DualTime iso={fullBid.submittedAt} zone={t.displayTimeZone} />
            </>
          ) : null}
        </span>
        {dirty ? (
          <Badge tone="warning">
            {autosaveState === 'saved'
              ? 'Unsaved changes kept in this tab'
              : autosaveState === 'unavailable'
                ? 'Unsaved changes (tab storage blocked)'
                : 'Unsaved changes'}
          </Badge>
        ) : (
          <Badge tone="neutral">All changes saved on the server</Badge>
        )}
      </div>
      {deadlineError ? (
        <Alert tone="danger" title="Deadline passed">
          The server clock passed the submission deadline before your submit arrived, so nothing
          changed on the server: the submission is atomic and was refused as a whole. Your edits
          remain only in this tab.
          {fullBid.submittedAt
            ? ' Your earlier submission stands exactly as it was.'
            : ' No bid was submitted.'}
        </Alert>
      ) : submit.isError ? (
        <Alert tone="danger" title="Submission failed">
          {errorMessage(submit.error)}
        </Alert>
      ) : saveRevision.isError ? (
        <Alert tone="danger" title="Could not save the revision">
          {errorMessage(saveRevision.error)}
        </Alert>
      ) : null}
      {!canEdit ? (
        <Alert
          tone="info"
          title={
            deadlinePassed ? 'Deadline passed: read-only' : `Bid is ${fullBid.status}: read-only`
          }
        >
          {deadlinePassed
            ? 'Revisions and submissions are no longer accepted.'
            : fullBid.status === 'withdrawn'
              ? 'A withdrawn bid is final: it cannot be revised, resubmitted or reopened.'
              : 'This bid can no longer be edited.'}
        </Alert>
      ) : null}
      {errors.length > 0 ? (
        <div role="alert" className="rounded-md border border-danger bg-danger-soft p-3 text-sm">
          <p className="font-medium">Please fix the following</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e.id}>
                <a href={`#${e.id}`} className="underline">
                  {e.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <fieldset disabled={!canEdit} className="space-y-6">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between">
              <CardTitle>Priced lines</CardTitle>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => update({ lines: [...form.lines, newLine()] })}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add line
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {form.lines.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No lines yet. A lump-sum bid needs only the total below.
                </p>
              ) : null}
              {form.lines.map((l, i) => (
                <fieldset
                  key={l.id}
                  className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-6"
                >
                  <legend className="px-1 text-xs text-fg-muted">Line {i + 1}</legend>
                  <Field
                    label="Description"
                    htmlFor={`line-${l.id}-description`}
                    className="sm:col-span-6"
                    required
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        value={l.description}
                        maxLength={500}
                        onChange={(e) => updateLine(l.id, { description: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label="Quantity"
                    htmlFor={`line-${l.id}-quantity`}
                    className="sm:col-span-1"
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.quantity}
                        onChange={(e) => updateLine(l.id, { quantity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Unit" htmlFor={`line-${l.id}-unit`} className="sm:col-span-1">
                    {({ id }) => (
                      <Input
                        id={id}
                        value={l.unit}
                        maxLength={32}
                        placeholder="m², bag, day"
                        onChange={(e) => updateLine(l.id, { unit: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Rate (₦)" htmlFor={`line-${l.id}-rate`} className="sm:col-span-2">
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.rateNaira}
                        onChange={(e) => updateLine(l.id, { rateNaira: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field
                    label="Amount (₦)"
                    htmlFor={`line-${l.id}-amount`}
                    className="sm:col-span-2"
                    required
                  >
                    {({ id }) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        value={l.amountNaira}
                        onChange={(e) => updateLine(l.id, { amountNaira: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="sm:col-span-6">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => update({ lines: form.lines.filter((x) => x.id !== l.id) })}
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </fieldset>
              ))}
              {form.lines.length > 0 ? (
                <p className="text-sm text-fg-muted">
                  Lines total {formatNairaString(linesTotalKobo)}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Total, duration and qualifications</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Total bid amount (₦)"
                htmlFor="bid-amount"
                required
                hint={
                  form.lines.length > 0
                    ? form.amountManual
                      ? 'Entered manually; differs from the lines total.'
                      : 'Follows the lines total. Edit to override.'
                    : 'Whole naira, optionally with two decimals. Stored as kobo.'
                }
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    inputMode="decimal"
                    value={form.amountNaira}
                    onChange={(e) =>
                      update({ amountNaira: e.target.value, amountManual: form.lines.length > 0 })
                    }
                  />
                )}
              </Field>
              <Field
                label="Duration (days)"
                htmlFor="bid-duration"
                hint="Working days to complete the scope."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={form.durationDays}
                    onChange={(e) => update({ durationDays: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Years of relevant experience" htmlFor="bid-years">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={form.experienceYears}
                    onChange={(e) => update({ experienceYears: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Team size" htmlFor="bid-team">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={form.teamSize}
                    onChange={(e) => update({ teamSize: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Qualifications statement"
                htmlFor="bid-statement"
                className="sm:col-span-2"
                hint="Comparable projects, certifications, method statement. Plain text."
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={form.statement}
                    maxLength={20000}
                    onChange={(e) => update({ statement: e.target.value })}
                  />
                )}
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {form.attachmentFileIds.length === 0 ? (
                <p className="text-fg-muted">No attachments.</p>
              ) : null}
              <ul className="space-y-1">
                {form.attachmentFileIds.map((id) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <span className="flex items-center gap-2">
                      <Paperclip aria-hidden="true" className="h-4 w-4" />
                      <code className="font-mono text-xs">{id}</code>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update({
                          attachmentFileIds: form.attachmentFileIds.filter((x) => x !== id),
                        })
                      }
                      aria-label={`Remove attachment ${id}`}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <label className="inline-flex items-center gap-2">
                <span className="sx-transition inline-flex h-11 cursor-pointer items-center rounded-md border border-border-strong bg-bg-elevated px-4 text-sm font-medium hover:bg-bg-sunken">
                  {uploading ? 'Uploading…' : 'Add file'}
                </span>
                <input
                  type="file"
                  className="sr-only"
                  accept="application/pdf,image/*,.docx,.xlsx,.csv,.zip"
                  disabled={uploading || !canEdit}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void addAttachment(f);
                  }}
                />
              </label>
              {uploadProblem ? (
                <NotAvailable title="Attachment upload" reason={uploadProblem} />
              ) : (
                <p className="text-xs text-fg-muted">
                  PDF, images, DOCX, XLSX, CSV or ZIP up to 64 MB. Files are scanned before they can
                  be referenced.
                </p>
              )}
            </CardContent>
          </Card>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!canEdit}
            loading={saveRevision.isPending}
            onClick={() => {
              const v = validate(form);
              setErrors(v.errors);
              if (v.input) saveRevision.mutate(v.input);
            }}
          >
            Save revision
          </Button>
          <Button
            type="button"
            disabled={!canEdit || deadlinePassed}
            loading={submit.isPending}
            onClick={() => {
              const v = validate(form);
              setErrors(v.errors);
              if (v.input) submit.mutate(v.input);
            }}
          >
            {fullBid.status === 'submitted' ? 'Re-submit bid' : 'Submit bid'}
          </Button>
          {canEdit ? (
            <Button type="button" variant="danger" onClick={() => setWithdrawOpen(true)}>
              Withdraw bid
            </Button>
          ) : null}
          {!known ? (
            <span className="self-center text-xs text-fg-muted">
              Countdown uses the device clock until the server responds; the server decides.
            </span>
          ) : null}
        </div>
      </form>
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent
          title="Withdraw this bid?"
          description="Withdrawal is final and recorded with your reason. A withdrawn bid cannot be revised, resubmitted or reopened for this tender."
        >
          <Field
            label="Reason"
            required
            error={withdraw.isError ? errorMessage(withdraw.error) : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setWithdrawOpen(false)}>
              Keep bid
            </Button>
            <Button
              variant="danger"
              loading={withdraw.isPending}
              disabled={withdrawReason.trim().length < 3}
              onClick={() => withdraw.mutate()}
            >
              Withdraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

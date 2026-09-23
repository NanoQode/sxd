'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, ReceiptText } from 'lucide-react';
import { useRef, useState } from 'react';
import type {
  AssignmentDto,
  Page,
  PartnerInvoiceDto,
  PartnerInvoiceSourceType,
  PurchaseOrderDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { koboToNairaInput, nairaInputToKobo } from '@/lib/partner/money';
import { partnerModules } from '@/lib/partner/nav';
import { waitForScan } from '@/lib/partner/scan-wait';
import { openSignedDownload, uploadFile } from '@/lib/partner/upload';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

/** What each payout status means for the partner. */
const STATUS_LABEL: Record<PartnerInvoiceDto['status'], { label: string; badge: string }> = {
  proposed: { label: 'Submitted, awaiting finance review', badge: 'pending' },
  first_approved: { label: 'Accepted by finance, awaiting second approval', badge: 'in_review' },
  approved: { label: 'Approved for payment', badge: 'approved' },
  submitted: { label: 'Payment sent to the bank', badge: 'submitted' },
  settled: { label: 'Paid', badge: 'successful' },
  failed: { label: 'Payment failed; finance is re-checking', badge: 'failed' },
  rejected: { label: 'Rejected', badge: 'rejected' },
};

const BILLABLE_ORDER: ReadonlySet<string> = new Set([
  'issued',
  'acknowledged',
  'partially_delivered',
  'delivered',
  'closed',
]);

interface Source {
  key: string;
  type: PartnerInvoiceSourceType;
  id: string;
  label: string;
  capKobo: string | null;
}

export function PartnerInvoicesPage() {
  const p = usePartner();
  const [open, setOpen] = useState(false);
  const invoices = useQuery({
    queryKey: ['partner', 'invoices'],
    queryFn: () =>
      partnerFetch<Page<PartnerInvoiceDto>>(withQuery('/api/v1/partner-invoices', { limit: 100 })),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        description="Bill SimplexD for a purchase order issued to you or an assignment you completed. Finance reviews every invoice; an accepted invoice is paid only after a second approver authorises it and the bank transfer is recorded."
        actions={
          p.isPartner ? (
            <Button onClick={() => setOpen(true)}>
              <ReceiptText aria-hidden="true" className="h-4 w-4" />
              Submit an invoice
            </Button>
          ) : null
        }
      />
      {!p.isPartner ? (
        <Alert tone="info" title="Partner accounts only">
          Invoices are submitted by partner accounts (a partner profile). Staff review them under
          Finance.
        </Alert>
      ) : null}
      {invoices.isPending ? (
        <LoadingBlock label="Loading invoices" />
      ) : invoices.isError ? (
        <RequestFailed
          error={invoices.error}
          onRetry={() => void invoices.refetch()}
          context="Invoices"
        />
      ) : invoices.data.items.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Submit one against a purchase order issued to you or an assignment marked completed. You will be notified at every step."
        />
      ) : (
        <DataTable
          caption="Your invoices"
          rows={invoices.data.items}
          rowKey={(i) => i.id}
          rowLabel={(i) => i.reference}
          columns={[
            {
              key: 'ref',
              header: 'Invoice',
              cell: (i) => (
                <span>
                  <span className="font-medium">{i.reference}</span>
                  <span className="block text-xs text-fg-muted">{i.source.label}</span>
                </span>
              ),
            },
            { key: 'amount', header: 'Amount', cell: (i) => formatNairaString(i.amountKobo) },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => (
                <span>
                  <StatusBadge status={STATUS_LABEL[i.status].badge} label={humanize(i.status)} />
                  <span className="block text-xs text-fg-muted">{STATUS_LABEL[i.status].label}</span>
                  {i.status === 'rejected' || i.status === 'failed' ? (
                    <span className="block text-xs text-danger">{i.failureReason}</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'submitted',
              header: 'Submitted',
              cell: (i) => <DualTime iso={i.submittedAt} zone={p.timeZone} />,
            },
            {
              key: 'history',
              header: 'History',
              cell: (i) => <InvoiceHistory invoice={i} zone={p.timeZone} />,
            },
          ]}
        />
      )}
      {p.isPartner ? <SubmitInvoiceDialog open={open} onOpenChange={setOpen} /> : null}
    </div>
  );
}

function InvoiceHistory({ invoice, zone }: { invoice: PartnerInvoiceDto; zone: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-sm text-primary underline">
        {invoice.history.length} step{invoice.history.length === 1 ? '' : 's'}
      </summary>
      <ol className="mt-2 space-y-1 text-xs">
        {invoice.history.map((h, idx) => (
          <li key={`${h.at}-${idx}`}>
            <span className="font-medium">{humanize(h.action)}</span> ·{' '}
            {formatDateTimeLabel(h.at, zone)}
            {h.byName ? ` · ${h.byName}` : ''}
            {h.note ? <span className="block text-fg-muted">{h.note}</span> : null}
          </li>
        ))}
        {invoice.attachmentFileId ? (
          <li>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void openSignedDownload(invoice.attachmentFileId!, 'inline')}
            >
              <Paperclip aria-hidden="true" className="h-3 w-3" />
              Invoice document
            </Button>
          </li>
        ) : null}
      </ol>
    </details>
  );
}

function SubmitInvoiceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const p = usePartner();
  const modules = partnerModules(p);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sourceKey, setSourceKey] = useState('');
  const [amountNaira, setAmountNaira] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [attachment, setAttachment] = useState<{
    id: string;
    name: string;
    pending: boolean;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const orders = useQuery({
    queryKey: ['partner', 'orders', 'billable'],
    queryFn: () =>
      partnerFetch<Page<PurchaseOrderDto>>(withQuery('/api/v1/purchase-orders', { limit: 100 })),
    enabled: open && modules.has('rfqs'),
  });
  const assignments = useQuery({
    queryKey: ['partner', 'assignments', 'completed'],
    queryFn: () =>
      partnerFetch<Page<AssignmentDto>>(
        withQuery('/api/v1/assignments/mine', { status: 'completed', limit: 100 }),
      ),
    enabled: open,
  });
  const sources: Source[] = [
    ...(orders.data?.items ?? [])
      .filter((o) => BILLABLE_ORDER.has(o.status))
      .map(
        (o): Source => ({
          key: `po:${o.id}`,
          type: 'purchase_order',
          id: o.id,
          label: `Purchase order ${o.number} · ${formatNairaString(o.totalKobo)}`,
          capKobo: o.totalKobo,
        }),
      ),
    ...(assignments.data?.items ?? []).map(
      (a): Source => ({
        key: `as:${a.id}`,
        type: 'assignment',
        id: a.id,
        label: `${humanize(a.role)} assignment · completed ${a.respondedAt ? formatDateTimeLabel(a.updatedAt, p.timeZone) : ''}`,
        capKobo: null,
      }),
    ),
  ];
  const selected = sources.find((s) => s.key === sourceKey) ?? sources[0] ?? null;
  const amountKobo = nairaInputToKobo(amountNaira);
  const amountProblem =
    amountNaira.trim() === ''
      ? null
      : amountKobo === null || BigInt(amountKobo) <= 0n
        ? 'Enter a positive naira amount, e.g. 1,250,000.50.'
        : selected?.capKobo && BigInt(amountKobo) > BigInt(selected.capKobo)
          ? `Exceeds the order total (${formatNairaString(selected.capKobo)}).`
          : null;
  const loading = assignments.isPending || (modules.has('rfqs') && orders.isPending);

  const submit = useMutation({
    mutationFn: () =>
      partnerFetch<PartnerInvoiceDto>('/api/v1/partner-invoices', {
        body: {
          source: { type: selected!.type, id: selected!.id },
          amountKobo,
          currency: 'NGN',
          reference: reference.trim(),
          description: description.trim() || undefined,
          attachmentFileId: attachment!.id,
        },
      }),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Invoice submitted',
        description: 'Finance has been notified. You will hear back when it is reviewed.',
      });
      onOpenChange(false);
      setAmountNaira('');
      setReference('');
      setDescription('');
      setAttachment(null);
      void qc.invalidateQueries({ queryKey: ['partner', 'invoices'] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not submit', description: errorMessage(err) }),
  });

  async function addFile(file: File) {
    setUploading(true);
    setUploadProblem(null);
    try {
      const res = await uploadFile(file, { purpose: 'partner_submission' });
      if (res.outcome === 'rejected') {
        setUploadProblem(res.file.statusReason ?? 'the file was rejected');
        return;
      }
      setAttachment({ id: res.file.id, name: file.name, pending: true });
      const scan = await waitForScan(res.file.id);
      if (scan.status === 'clean') {
        setAttachment((a) => (a && a.id === res.file.id ? { ...a, pending: false } : a));
      } else if (scan.status === 'scanning') {
        setUploadProblem('The document is still being scanned; wait a moment and try again.');
      } else {
        setAttachment(null);
        setUploadProblem(`The document was refused: ${scan.reason ?? scan.status}`);
      }
    } catch (err) {
      setUploadProblem(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  const valid =
    selected !== null &&
    amountKobo !== null &&
    amountProblem === null &&
    reference.trim().length >= 2 &&
    attachment !== null &&
    !attachment.pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Submit an invoice"
        description="Against a purchase order issued to you or an assignment marked completed. Attach your invoice document; amounts are in naira."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit.mutate();
          }}
        >
          {loading ? (
            <p className="text-sm text-fg-muted">Loading what you can invoice…</p>
          ) : sources.length === 0 ? (
            <Alert tone="info" title="Nothing to invoice yet">
              An invoice needs a purchase order issued to you or an assignment that staff marked
              completed. Neither is on your account yet.
            </Alert>
          ) : (
            <Field label="For" htmlFor="inv-source" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={selected?.key ?? ''}
                  onChange={(e) => setSourceKey(e.target.value)}
                >
                  {sources.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
          <Field
            label="Amount (naira)"
            htmlFor="inv-amount"
            required
            error={amountProblem ?? undefined}
            hint={
              amountKobo && !amountProblem
                ? `${koboToNairaInput(amountKobo)} naira = ${amountKobo} kobo`
                : undefined
            }
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                inputMode="decimal"
                value={amountNaira}
                onChange={(e) => setAmountNaira(e.target.value)}
                placeholder="1,250,000.50"
              />
            )}
          </Field>
          <Field
            label="Your invoice number"
            htmlFor="inv-ref"
            required
            hint="Must be unique among your invoices."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={reference}
                maxLength={120}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description" htmlFor="inv-desc">
            {({ id }) => (
              <Textarea
                id={id}
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div>
            <p className="text-sm font-medium">
              Invoice document <span className="text-danger">*</span>
            </p>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              accept="application/pdf,image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addFile(f);
                e.target.value = '';
              }}
            />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" className="h-4 w-4" />
                {attachment ? 'Replace document' : 'Attach document'}
              </Button>
              {attachment ? (
                <Badge tone={attachment.pending ? 'warning' : 'success'}>
                  {attachment.name}
                  {attachment.pending ? ' · scanning' : ' · ready'}
                </Badge>
              ) : null}
            </div>
            {uploadProblem ? (
              <p role="alert" className="mt-1 text-xs text-danger">
                {uploadProblem}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submit.isPending} disabled={!valid}>
              Submit invoice
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

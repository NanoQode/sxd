'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import type {
  DiscrepancyProposedResolution,
  DiscrepancyThreadDto,
  PurchaseOrderDetail,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Field,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { waitForScan } from '@/lib/partner/scan-wait';
import { openSignedDownload, uploadFile } from '@/lib/partner/upload';
import { LoadingBlock, RequestFailed } from '../common';

const PROPOSALS: Array<{ value: DiscrepancyProposedResolution; label: string; hint: string }> = [
  {
    value: 'replace',
    label: 'Replace the goods',
    hint: 'You will deliver the missing or replacement items.',
  },
  {
    value: 'credit',
    label: 'Issue a credit',
    hint: 'The shortfall is credited against the order.',
  },
  {
    value: 'dispute',
    label: 'Dispute the finding',
    hint: 'You disagree with what was recorded; explain why and attach evidence.',
  },
];

const STATE_TONE: Record<
  DiscrepancyThreadDto['responseState'],
  'warning' | 'primary' | 'danger' | 'success' | 'neutral'
> = {
  awaiting_supplier: 'warning',
  responded: 'primary',
  rejected: 'danger',
  accepted: 'success',
  closed: 'neutral',
};

const STATE_LABEL: Record<DiscrepancyThreadDto['responseState'], string> = {
  awaiting_supplier: 'Your response needed',
  responded: 'Awaiting staff decision',
  rejected: 'Proposal rejected — you can reply again',
  accepted: 'Proposal accepted',
  closed: 'Closed by staff',
};

/** Discrepancy threads of one delivery: what staff raised, your replies, their decisions, and the reply form. */
export function DeliveryDiscrepancyThreads({
  deliveryId,
  order,
}: {
  deliveryId: string;
  order: PurchaseOrderDetail;
}) {
  const threads = useQuery({
    queryKey: ['partner', 'discrepancy-threads', deliveryId],
    queryFn: () =>
      partnerFetch<{ items: DiscrepancyThreadDto[] }>(
        `/api/v1/deliveries/${deliveryId}/discrepancy-threads`,
      ),
  });
  if (threads.isPending) return <LoadingBlock rows={1} label="Loading discrepancies" />;
  if (threads.isError)
    return (
      <RequestFailed
        error={threads.error}
        onRetry={() => void threads.refetch()}
        context="Discrepancies"
      />
    );
  if (threads.data.items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-3" aria-label="Discrepancies on this delivery">
      {threads.data.items.map((t) => (
        <li key={t.discrepancy.id}>
          <DiscrepancyThread thread={t} deliveryId={deliveryId} order={order} />
        </li>
      ))}
    </ul>
  );
}

function DiscrepancyThread({
  thread,
  deliveryId,
  order,
}: {
  thread: DiscrepancyThreadDto;
  deliveryId: string;
  order: PurchaseOrderDetail;
}) {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const d = thread.discrepancy;
  const line = order.lines.find((l) => l.lineId === d.lineId);
  const [response, setResponse] = useState('');
  const [proposal, setProposal] = useState<DiscrepancyProposedResolution>('replace');
  const [files, setFiles] = useState<Array<{ id: string; name: string; pending: boolean }>>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(thread.responseState === 'awaiting_supplier');
  const fileInput = useRef<HTMLInputElement>(null);

  const respond = useMutation({
    mutationFn: () =>
      partnerFetch<DiscrepancyThreadDto>(
        `/api/v1/deliveries/${deliveryId}/discrepancies/${d.id}/respond`,
        {
          body: {
            response: response.trim(),
            proposedResolution: proposal,
            evidenceFileIds: files.map((f) => f.id),
          },
        },
      ),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Response sent', description: 'Staff have been notified.' });
      setResponse('');
      setFiles([]);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['partner', 'discrepancy-threads', deliveryId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'deliveries'] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Response not sent', description: errorMessage(err) }),
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
      setFiles((f) => [...f, { id: res.file.id, name: file.name, pending: true }]);
      // The server links a file only once the malware scan passed; wait for it here.
      const scan = await waitForScan(res.file.id);
      if (scan.status === 'clean') {
        setFiles((f) => f.map((x) => (x.id === res.file.id ? { ...x, pending: false } : x)));
      } else if (scan.status === 'scanning') {
        setUploadProblem(
          `${file.name} is still being scanned; try sending again in a moment or remove it.`,
        );
      } else {
        setFiles((f) => f.filter((x) => x.id !== res.file.id));
        setUploadProblem(`${file.name} was refused: ${scan.reason ?? scan.status}`);
      }
    } catch (err) {
      setUploadProblem(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <article className="rounded-md border border-warning/50 bg-warning-soft/40 p-3 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">{humanize(d.kind)}</Badge>
        <StatusBadge status={d.status} />
        <Badge tone={STATE_TONE[thread.responseState]}>{STATE_LABEL[thread.responseState]}</Badge>
        {d.quantity ? <span>Quantity {d.quantity}</span> : null}
        {line ? <span className="text-fg-muted">{line.specification}</span> : null}
      </header>
      <p className="mt-2">{d.description}</p>
      <p className="text-xs text-fg-muted">
        Raised {formatDateTimeLabel(d.createdAt, p.timeZone)}
        {d.resolvedAt ? ` · closed ${formatDateTimeLabel(d.resolvedAt, p.timeZone)}` : ''}
      </p>
      {d.resolution &&
      !thread.entries.some((e) => e.kind === 'staff_decision' && e.decision === 'accept') ? (
        <p className="mt-1 text-fg-muted">Resolution: {d.resolution}</p>
      ) : null}
      {thread.entries.length > 0 ? (
        <ol className="mt-3 space-y-2" aria-label="Responses and decisions">
          {thread.entries.map((e) => (
            <li
              key={e.id}
              className={`rounded-md border p-2 ${e.kind === 'supplier_response' ? 'border-primary/30 bg-primary-soft' : 'border-border bg-bg-elevated'}`}
            >
              <p className="text-xs text-fg-muted">
                {e.kind === 'supplier_response'
                  ? e.authorUserId === p.userId
                    ? 'You'
                    : (e.authorName ?? 'Supplier')
                  : `SimplexD · ${e.authorName ?? 'staff'}`}{' '}
                · {formatDateTimeLabel(e.createdAt, p.timeZone)}
                {e.kind === 'supplier_response' && e.proposedResolution
                  ? ` · proposed: ${PROPOSALS.find((x) => x.value === e.proposedResolution)?.label ?? humanize(e.proposedResolution)}`
                  : ''}
                {e.kind === 'staff_decision'
                  ? ` · ${e.decision === 'accept' ? `accepted (${humanize(e.outcome ?? 'resolved')})` : 'rejected'}`
                  : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{e.text}</p>
              {e.evidenceFileIds.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {e.evidenceFileIds.map((fileId, i) => (
                    <Button
                      key={fileId}
                      size="sm"
                      variant="secondary"
                      onClick={() => void openSignedDownload(fileId, 'inline')}
                    >
                      <Paperclip aria-hidden="true" className="h-3 w-3" />
                      Evidence {i + 1}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {thread.canRespond ? (
        open ? (
          <form
            className="mt-3 space-y-3 rounded-md border border-border bg-bg-elevated p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (response.trim().length >= 3 && !files.some((f) => f.pending)) respond.mutate();
            }}
          >
            <Field label="Your response" htmlFor={`resp-${d.id}`} required>
              {({ id }) => (
                <Textarea
                  id={id}
                  value={response}
                  minLength={3}
                  maxLength={4000}
                  onChange={(e) => setResponse(e.target.value)}
                  placeholder="What happened, and what you propose"
                />
              )}
            </Field>
            <Field
              label="Proposed resolution"
              htmlFor={`prop-${d.id}`}
              hint={PROPOSALS.find((x) => x.value === proposal)?.hint}
            >
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={proposal}
                  onChange={(e) => setProposal(e.target.value as DiscrepancyProposedResolution)}
                >
                  {PROPOSALS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <div>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                accept="image/*,application/pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void addFile(f);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" className="h-4 w-4" />
                Attach evidence
              </Button>
              {files.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                  {files.map((f) => (
                    <li key={f.id} className="rounded-md border border-border px-2 py-1">
                      {f.name}
                      {f.pending ? ' · scan pending' : ''}{' '}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {uploadProblem ? (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {uploadProblem}
                </p>
              ) : null}
              {files.some((f) => f.pending) ? (
                <p className="mt-1 text-xs text-fg-muted">
                  A file is still being scanned; it can be sent once the scan passes.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                loading={respond.isPending}
                disabled={response.trim().length < 3 || files.some((f) => f.pending)}
              >
                Send response
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {thread.responseState === 'rejected' ? 'Reply again' : 'Respond'}
          </Button>
        )
      ) : thread.responseState === 'responded' ? (
        <Alert tone="info" title="Awaiting staff" className="mt-3">
          Your response is on record; staff will accept or reject the proposal.
        </Alert>
      ) : null}
    </article>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DeliveryLogItemDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  formatNairaString,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { DefinitionList, Mono, fmtDate } from '../../_components/bits';
import { DeliveryTimeline } from '../_components/delivery-timeline';
import {
  CHANNEL_LABELS,
  DELIVERY_CONFIRMATION_LABELS,
  DELIVERY_STATUS_LABELS,
  DELIVERY_STATUS_TONES,
  DEV_ADAPTER_LABEL,
  RETRY_BLOCK_LABELS,
  explainReason,
} from '../_lib/labels';

const DELIVERIES = '/api/v1/admin/notifications/deliveries';

function StatusPill({ item }: { item: DeliveryLogItemDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={DELIVERY_STATUS_TONES[item.status] ?? 'neutral'}>
        {DELIVERY_STATUS_LABELS[item.status] ?? item.status}
      </Badge>
      {item.developmentAdapter ? <Badge tone="warning">dev adapter</Badge> : null}
      {item.isTest ? <Badge tone="neutral">test</Badge> : null}
    </span>
  );
}

/** Attempt detail dialog with the status timeline and the retry action. */
function DetailDialog({
  item,
  onClose,
  onRetried,
}: {
  item: DeliveryLogItemDto;
  onClose: () => void;
  onRetried: (retry: DeliveryLogItemDto) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{
        created: boolean;
        original: DeliveryLogItemDto;
        retry: DeliveryLogItemDto;
      }>(`${DELIVERIES}/${item.id}/retry`, { method: 'POST', body: {} });
      toast({
        title: res.created
          ? `Retry sent: ${DELIVERY_STATUS_LABELS[res.retry.status] ?? res.retry.status}`
          : 'This attempt was already retried; nothing new was sent',
        description: res.retry.errorSanitized ?? undefined,
        tone: res.retry.status === 'failed' ? 'danger' : res.created ? 'success' : 'info',
      });
      onRetried(res.retry);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const explanation = explainReason(item.errorSanitized);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${CHANNEL_LABELS[item.channel] ?? item.channel} to ${item.recipientMasked}`}
        description={`${item.templateKey ?? 'no template'}${item.templateVersion ? ` v${item.templateVersion}` : ''} · ${item.category}`}
        size="lg"
      >
        <div className="space-y-4 text-sm">
          {error ? (
            <Alert tone="danger" title="Retry failed">
              {error}
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill item={item} />
            <span className="text-fg-muted">{DELIVERY_CONFIRMATION_LABELS[item.delivery]}</span>
          </div>
          {item.developmentAdapter ? (
            <Alert tone="warning" title={DEV_ADAPTER_LABEL}>
              Recorded by the in-memory development adapter; nothing reached a real provider.
            </Alert>
          ) : null}
          <DeliveryTimeline steps={item.timeline} />
          <DefinitionList
            items={[
              {
                term: 'Failure reason',
                value: item.errorSanitized ? (
                  <>
                    <Mono>{item.errorSanitized}</Mono>
                    {explanation ? <span className="ml-2 text-fg-muted">{explanation}</span> : null}
                  </>
                ) : null,
              },
              {
                term: 'Provider',
                value: `${item.provider} · ${item.environment}`,
              },
              {
                term: 'Provider message id',
                value: item.providerMessageId ? <Mono>{item.providerMessageId}</Mono> : null,
              },
              { term: 'Provider status', value: item.providerStatus },
              { term: 'Subject / title', value: item.subject },
              {
                term: 'Segments · estimated cost',
                value:
                  item.segments !== null
                    ? `${item.segments} · ${item.estimatedCostKobo ? formatNairaString(item.estimatedCostKobo) : 'n/a'}`
                    : null,
              },
              { term: 'Send attempts', value: String(item.attempts) },
              {
                term: 'Related record',
                value: item.relatedEntityType
                  ? `${item.relatedEntityType}${item.relatedEntityId ? ` ${item.relatedEntityId}` : ''}`
                  : null,
              },
              { term: 'User id', value: item.userId ? <Mono>{item.userId}</Mono> : null },
              { term: 'Attempt id', value: <Mono>{item.id}</Mono> },
              {
                term: 'Retry of',
                value: item.retryOf ? <Mono>{item.retryOf}</Mono> : null,
              },
              {
                term: 'Retried by',
                value: item.retriedBy ? <Mono>{item.retriedBy}</Mono> : null,
              },
            ]}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Close
            </Button>
            {item.retry.allowed ? (
              <Button onClick={retry} loading={busy} loadingLabel="Retrying">
                Retry this attempt
              </Button>
            ) : (
              <p className="text-xs text-fg-muted">
                {RETRY_BLOCK_LABELS[item.retry.reason ?? ''] ?? 'Retry not available.'}
              </p>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DeliveryLogTable({ items }: { items: DeliveryLogItemDto[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<DeliveryLogItemDto | null>(null);

  const columns: Column<DeliveryLogItemDto>[] = [
    {
      key: 'when',
      header: 'Queued',
      cell: (i) => <span className="text-xs">{fmtDate(i.queuedAt)}</span>,
    },
    {
      key: 'channel',
      header: 'Channel',
      cell: (i) => <Badge tone="neutral">{CHANNEL_LABELS[i.channel] ?? i.channel}</Badge>,
    },
    {
      key: 'template',
      header: 'Template',
      cell: (i) => (
        <span className="text-xs">
          {i.templateKey ?? '—'}
          {i.templateVersion ? <span className="text-fg-muted"> v{i.templateVersion}</span> : null}
        </span>
      ),
    },
    {
      key: 'recipient',
      header: 'Recipient',
      cell: (i) => <Mono>{i.recipientMasked}</Mono>,
    },
    { key: 'status', header: 'Status', cell: (i) => <StatusPill item={i} /> },
    {
      key: 'reason',
      header: 'Reason',
      cell: (i) =>
        i.errorSanitized ? (
          <span className="block max-w-xs truncate text-xs text-fg-muted" title={i.errorSanitized}>
            {i.errorSanitized}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (i) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(i)}>
            Details
          </Button>
          {i.retry.allowed ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(i)}>
              Retry…
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(i) => i.id}
        rowLabel={(i) => `${i.channel} to ${i.recipientMasked}`}
        caption="Delivery attempts"
        emptyMessage="No attempts match these filters."
      />
      {open ? (
        <DetailDialog
          item={open}
          onClose={() => setOpen(null)}
          onRetried={() => {
            setOpen(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

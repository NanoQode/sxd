'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AdminJobDto, JobStatus, StuckOutboxEventDto } from '@simplexd/contracts';
import { Badge, Button, DataTable, EmptyState, useToast, type Column } from '@simplexd/ui';
import { adminFetch } from '@/lib/admin/client';
import { ActionDialog } from '../_components/action-dialog';
import { DefinitionList, Mono, fmtDate } from '../_components/bits';

const STATUS_TONE: Record<JobStatus, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  dead: 'danger',
  failed: 'danger',
  pending: 'warning',
  running: 'info',
  succeeded: 'success',
  cancelled: 'neutral',
};

function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

function ErrorText({ value }: { value: string | null }) {
  if (!value) return <span className="text-fg-subtle">—</span>;
  return <span className="block max-w-md text-xs break-words text-fg-muted">{value}</span>;
}

const EMPTY_JOBS: Record<string, { title: string; description: string }> = {
  dead: {
    title: 'No dead jobs',
    description:
      'Every job has either succeeded or is still within its retry budget. Jobs land here after exhausting their attempts.',
  },
  failed: { title: 'No failed jobs', description: 'Nothing is recorded as failed.' },
  pending: {
    title: 'No pending jobs',
    description: 'The queue is empty; the worker has nothing waiting to run.',
  },
  running: { title: 'No running jobs', description: 'No worker is executing a job right now.' },
};

/**
 * Jobs of one status. Dead rows get a Retry action only when the viewer may
 * retry (platform.settings.manage with a verified authenticator); otherwise
 * the table is read-only and the page explains why.
 */
export function JobsTable({
  items,
  status,
  canManage,
}: {
  items: AdminJobDto[];
  status: JobStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [target, setTarget] = useState<AdminJobDto | null>(null);

  async function retry(reason: string) {
    if (!target) return;
    await adminFetch<AdminJobDto>(`/api/v1/admin/jobs/${target.id}/retry`, {
      method: 'POST',
      body: { reason },
      idempotent: true,
    });
    toast({
      title: `${target.type} queued again`,
      description: 'Attempts were reset; the worker picks it up on its next poll.',
      tone: 'success',
    });
    router.refresh();
  }

  if (items.length === 0) {
    const empty = EMPTY_JOBS[status] ?? { title: `No ${status} jobs`, description: '' };
    return <EmptyState title={empty.title} description={empty.description || undefined} />;
  }

  const columns: Column<AdminJobDto>[] = [
    {
      key: 'type',
      header: 'Job',
      mobileLabel: 'Queue',
      cell: (job) => (
        <span className="block min-w-0">
          <span className="hidden font-medium break-words md:block">{job.type}</span>
          <span className="text-xs text-fg-muted">{job.queue}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (job) => <JobStatusBadge status={job.status} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      cell: (job) => (
        <span className="tabular-nums">
          {job.attempts} of {job.maxAttempts}
        </span>
      ),
    },
    { key: 'error', header: 'Last error', cell: (job) => <ErrorText value={job.lastError} /> },
    {
      key: 'payload',
      header: 'Payload fields',
      hideOnMobile: true,
      cell: (job) =>
        job.payloadKeys.length > 0 ? (
          <span className="text-xs break-words text-fg-muted">{job.payloadKeys.join(', ')}</span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      key: 'updated',
      header: 'Last change',
      cell: (job) => <span className="text-xs">{fmtDate(job.updatedAt)}</span>,
    },
    {
      key: 'correlation',
      header: 'Correlation',
      hideOnMobile: true,
      cell: (job) => (job.correlationId ? <Mono>{job.correlationId}</Mono> : '—'),
    },
  ];
  if (canManage) {
    columns.push({
      key: 'actions',
      header: 'Action',
      cell: (job) =>
        job.status === 'dead' ? (
          <Button size="sm" variant="secondary" onClick={() => setTarget(job)}>
            Retry
          </Button>
        ) : (
          <span className="text-xs text-fg-muted">Only dead jobs can be retried</span>
        ),
    });
  }

  return (
    <>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(job) => job.id}
        rowLabel={(job) => job.type}
        caption={`${status} jobs`}
      />
      {canManage ? (
        <ActionDialog
          open={target !== null}
          onOpenChange={(open) => !open && setTarget(null)}
          title={target ? `Retry ${target.type}` : 'Retry job'}
          description="The job goes back to pending with its attempts reset and runs on the next worker poll. Fix the cause first, or it will fail the same way."
          confirmLabel="Retry job"
          requireReason
          onConfirm={retry}
        >
          {target ? (
            <DefinitionList
              items={[
                { term: 'Queue', value: target.queue },
                { term: 'Attempts', value: `${target.attempts} of ${target.maxAttempts}` },
                { term: 'Last error', value: <ErrorText value={target.lastError} /> },
                { term: 'Job id', value: <Mono>{target.id}</Mono> },
              ]}
            />
          ) : null}
        </ActionDialog>
      ) : null}
    </>
  );
}

/** Outbox events the relay stopped claiming, with Requeue for viewers who may manage them. */
export function StuckOutboxTable({
  items,
  canManage,
  threshold,
}: {
  items: StuckOutboxEventDto[];
  canManage: boolean;
  threshold: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [target, setTarget] = useState<StuckOutboxEventDto | null>(null);

  async function requeue(reason: string) {
    if (!target) return;
    await adminFetch(`/api/v1/admin/outbox/${target.id}/requeue`, {
      method: 'POST',
      body: { reason },
      idempotent: true,
    });
    toast({
      title: `Outbox event #${target.id} requeued`,
      description: 'The relay will claim it on its next pass.',
      tone: 'success',
    });
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No stuck outbox events"
        description={`No unpublished event has reached ${threshold} failed routing attempts.`}
      />
    );
  }

  const columns: Column<StuckOutboxEventDto>[] = [
    {
      key: 'event',
      header: 'Event',
      mobileLabel: 'Aggregate',
      cell: (e) => (
        <span className="block min-w-0">
          <span className="hidden font-medium break-words md:block">{e.eventType}</span>
          <span className="text-xs break-words text-fg-muted">
            {e.aggregateType} {e.aggregateId}
          </span>
        </span>
      ),
    },
    { key: 'attempts', header: 'Attempts', cell: (e) => <span>{e.attempts}</span> },
    { key: 'error', header: 'Last error', cell: (e) => <ErrorText value={e.lastError} /> },
    {
      key: 'created',
      header: 'Created',
      cell: (e) => <span className="text-xs">{fmtDate(e.createdAt)}</span>,
    },
    {
      key: 'correlation',
      header: 'Correlation',
      hideOnMobile: true,
      cell: (e) => (e.correlationId ? <Mono>{e.correlationId}</Mono> : '—'),
    },
  ];
  if (canManage) {
    columns.push({
      key: 'actions',
      header: 'Action',
      cell: (e) => (
        <Button size="sm" variant="secondary" onClick={() => setTarget(e)}>
          Requeue
        </Button>
      ),
    });
  }

  return (
    <>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(e) => String(e.id)}
        rowLabel={(e) => `#${e.id} ${e.eventType}`}
        caption="Stuck outbox events"
      />
      {canManage ? (
        <ActionDialog
          open={target !== null}
          onOpenChange={(open) => !open && setTarget(null)}
          title={target ? `Requeue outbox event #${target.id}` : 'Requeue outbox event'}
          description="Attempts reset to 0 and the last error is cleared, so the relay routes the event again. Fix the routing failure first."
          confirmLabel="Requeue event"
          requireReason
          onConfirm={requeue}
        >
          {target ? (
            <DefinitionList
              items={[
                { term: 'Event', value: target.eventType },
                { term: 'Aggregate', value: `${target.aggregateType} ${target.aggregateId}` },
                { term: 'Last error', value: <ErrorText value={target.lastError} /> },
              ]}
            />
          ) : null}
        </ActionDialog>
      ) : null}
    </>
  );
}

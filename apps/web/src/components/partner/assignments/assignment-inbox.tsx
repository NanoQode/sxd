'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { AssignmentDto, Page } from '@simplexd/contracts';
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
  EmptyState,
  Field,
  NativeSelect,
  PageHeader,
  StatusBadge,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

const STATUS_FILTERS = [
  'all',
  'proposed',
  'accepted',
  'active',
  'completed',
  'declined',
  'revoked',
] as const;

export function AssignmentInbox() {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [declining, setDeclining] = useState<AssignmentDto | null>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({
    queryKey: ['partner', 'assignments', status],
    queryFn: () =>
      partnerFetch<Page<AssignmentDto>>(
        withQuery('/api/v1/assignments/mine', {
          status: status === 'all' ? undefined : status,
          limit: 100,
        }),
      ),
  });
  const respond = useMutation({
    mutationFn: (input: {
      id: string;
      action: 'accept' | 'decline' | 'complete';
      reason?: string;
    }) =>
      partnerFetch<AssignmentDto>(`/api/v1/assignments/${input.id}/${input.action}`, {
        body: input.action === 'decline' ? { reason: input.reason || undefined } : {},
      }),
    onSuccess: (a, input) => {
      toast({
        tone: 'success',
        title: `Assignment ${input.action === 'accept' ? 'accepted' : input.action === 'decline' ? 'declined' : 'completed'}`,
      });
      void qc.invalidateQueries({ queryKey: ['partner', 'assignments'] });
      setDeclining(null);
      setReason('');
    },
    onError: (err) =>
      toast({
        tone: 'danger',
        title: 'Could not update the assignment',
        description: errorMessage(err),
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assignments"
        description="Work proposed to you by SimplexD staff. Accept to gain access to the project or request; decline with a short reason."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Status</span>
            <NativeSelect
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === 'all' ? 'All' : humanize(s)}
                </option>
              ))}
            </NativeSelect>
          </label>
        }
      />
      {list.isPending ? (
        <LoadingBlock label="Loading assignments" />
      ) : list.isError ? (
        <RequestFailed
          error={list.error}
          onRetry={() => void list.refetch()}
          context="Assignments"
        />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title="No assignments"
          description={
            status === 'all'
              ? 'Nothing has been assigned to you yet. Staff propose assignments from a project or service request; you will be notified.'
              : `No ${humanize(status).toLowerCase()} assignments.`
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.data.items.map((a) => (
            <li key={a.id}>
              <Card className="h-full">
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{humanize(a.role)}</CardTitle>
                    <p className="text-xs text-fg-muted">
                      {a.projectId ? 'Project' : 'Service request'} · assigned{' '}
                      {a.assignedBy ? 'by staff' : ''}
                    </p>
                  </div>
                  <StatusBadge status={a.status} />
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {a.instructions ? (
                    <p className="whitespace-pre-wrap">{a.instructions}</p>
                  ) : (
                    <p className="text-fg-muted">No instructions given.</p>
                  )}
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-fg-muted">Starts</dt>
                      <dd>
                        <DualTime iso={a.startsAt} zone={p.timeZone} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Ends</dt>
                      <dd>
                        <DualTime iso={a.endsAt} zone={p.timeZone} />
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    {a.status === 'proposed' ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => respond.mutate({ id: a.id, action: 'accept' })}
                          loading={
                            respond.isPending &&
                            respond.variables?.id === a.id &&
                            respond.variables.action === 'accept'
                          }
                        >
                          Accept
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setDeclining(a)}>
                          Decline
                        </Button>
                      </>
                    ) : null}
                    {a.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => respond.mutate({ id: a.id, action: 'complete' })}
                        loading={respond.isPending && respond.variables?.id === a.id}
                      >
                        Mark complete
                      </Button>
                    ) : null}
                    {a.status === 'accepted' ? (
                      <Badge tone="info">Waiting for staff to activate</Badge>
                    ) : null}
                    {(a.status === 'accepted' || a.status === 'active') && a.projectId ? (
                      <>
                        <Link
                          href={`/partner/visits?projectId=${a.projectId}`}
                          className="text-sm text-primary underline"
                        >
                          Visits
                        </Link>
                        <Link
                          href={`/partner/evidence?projectId=${a.projectId}`}
                          className="text-sm text-primary underline"
                        >
                          Evidence
                        </Link>
                        <Link
                          href={`/partner/reports?projectId=${a.projectId}`}
                          className="text-sm text-primary underline"
                        >
                          Reports
                        </Link>
                      </>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={declining !== null} onOpenChange={(o) => (!o ? setDeclining(null) : undefined)}>
        {declining ? (
          <DialogContent
            title="Decline this assignment?"
            description="Staff see your reason and may propose it to someone else."
          >
            <Field label="Reason (optional)" hint="Up to 2000 characters.">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
            {respond.isError ? (
              <Alert tone="danger" className="mt-3" title="Could not decline">
                {errorMessage(respond.error)}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDeclining(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={respond.isPending}
                onClick={() => respond.mutate({ id: declining.id, action: 'decline', reason })}
              >
                Decline assignment
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { NotificationDto } from '@simplexd/contracts';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { LoadingBlock, RequestFailed } from '../common';

interface Feed {
  items: NotificationDto[];
  nextCursor: string | null;
  unreadCount: number;
}

export function NotificationsFeed() {
  const p = usePartner();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useQuery({
    queryKey: ['partner', 'notifications', 'feed', unreadOnly],
    queryFn: () =>
      partnerFetch<Feed>(
        withQuery('/api/v1/notifications', {
          unreadOnly: unreadOnly ? 'true' : undefined,
          limit: 50,
        }),
      ),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['partner', 'notifications'] });
  const readOne = useMutation({
    mutationFn: (id: string) => partnerFetch(`/api/v1/notifications/${id}/read`, { body: {} }),
    onSuccess: invalidate,
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not mark as read', description: errorMessage(err) }),
  });
  const readAll = useMutation({
    mutationFn: () => partnerFetch(`/api/v1/notifications/read-all`, { body: {} }),
    onSuccess: invalidate,
    onError: (err) =>
      toast({
        tone: 'danger',
        title: 'Could not mark all as read',
        description: errorMessage(err),
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Assignments, tender answers and awards, order updates and report reviews. Email and SMS copies follow your notification preferences."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly((v) => !v)}
            >
              {unreadOnly ? 'Showing unread' : 'Show unread only'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => readAll.mutate()}
              loading={readAll.isPending}
              disabled={(feed.data?.unreadCount ?? 0) === 0}
            >
              Mark all read
            </Button>
          </>
        }
      />
      {feed.isPending ? (
        <LoadingBlock label="Loading notifications" />
      ) : feed.isError ? (
        <RequestFailed
          error={feed.error}
          onRetry={() => void feed.refetch()}
          context="Notifications"
        />
      ) : feed.data.items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
          description="You will be notified here when something needs you."
        />
      ) : (
        <ul className="space-y-2">
          {feed.data.items.map((n) => (
            <li
              key={n.id}
              className={`flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm ${n.readAt ? 'border-border' : 'border-primary/40 bg-primary-soft/40'}`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {n.title}
                  {!n.readAt ? <Badge tone="primary">New</Badge> : null}
                  <Badge tone="neutral">{humanize(n.category)}</Badge>
                </p>
                {n.body ? <p className="mt-1 text-fg-muted">{n.body}</p> : null}
                <p className="mt-1 text-xs text-fg-muted">
                  {formatDateTimeLabel(n.createdAt, p.timeZone)}
                </p>
              </div>
              <div className="flex gap-2">
                {n.linkPath && n.linkPath.startsWith('/') ? (
                  <Link
                    href={n.linkPath}
                    className="text-primary underline"
                    onClick={() => (!n.readAt ? readOne.mutate(n.id) : undefined)}
                  >
                    Open
                  </Link>
                ) : null}
                {!n.readAt ? (
                  <Button size="sm" variant="ghost" onClick={() => readOne.mutate(n.id)}>
                    Mark read
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {feed.data?.nextCursor ? (
        <p className="text-xs text-fg-muted">
          Older notifications exist; the feed shows the latest 50.
        </p>
      ) : null}
    </div>
  );
}

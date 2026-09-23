'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { NotificationDto } from '@simplexd/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  cn,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

interface FeedPage {
  items: NotificationDto[];
  nextCursor: string | null;
  unreadCount: number;
}

/** In-app notification feed with per-item and read-all actions. */
export function NotificationsFeed({ zone }: { zone: string }) {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const queryKey = useMemo(() => ['notifications', unreadOnly], [unreadOnly]);
  const feed = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      portalFetch<FeedPage>(
        `/api/v1/notifications?${new URLSearchParams({ limit: '25', unreadOnly: String(unreadOnly), ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({
    mutationFn: (id: string) =>
      portalFetch(`/api/v1/notifications/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => void invalidate(),
  });
  const readAll = useMutation({
    mutationFn: () =>
      portalFetch<{ marked: number }>('/api/v1/notifications/read-all', {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void invalidate(),
  });

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = feed.data?.pages[0]?.unreadCount ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Badge tone={unreadCount > 0 ? 'primary' : 'neutral'}>{unreadCount} unread</Badge>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            Unread only
          </label>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => readAll.mutate()}
          loading={readAll.isPending}
          disabled={unreadCount === 0}
        >
          Mark all read
        </Button>
      </div>
      {feed.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full" label="Loading notifications" />
          <Skeleton className="h-14 w-full" label="Loading notifications" />
        </div>
      ) : feed.isError ? (
        <ErrorState
          title="Notifications did not load"
          message={describeError(feed.error).message}
          correlationId={describeError(feed.error).correlationId}
          action={
            <Button type="button" variant="secondary" onClick={() => void feed.refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          description="Quotes, invoices, approvals, appointments and messages notify you here and by the channels in your settings."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-start sm:justify-between',
                n.readAt ? 'border-border' : 'border-primary/40 bg-primary-soft/40',
              )}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.title}</span>
                  <Badge tone="neutral">{humanize(n.category)}</Badge>
                  {!n.readAt ? <Badge tone="primary">New</Badge> : null}
                </p>
                {n.body ? <p className="text-fg-muted">{n.body}</p> : null}
                <p className="text-xs text-fg-subtle">{formatDateTimeLabel(n.createdAt, zone)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {n.linkPath ? (
                  <Link
                    href={n.linkPath}
                    className="sx-touch inline-flex items-center text-sm font-medium text-primary underline"
                    onClick={() => !n.readAt && readOne.mutate(n.id)}
                  >
                    Open
                  </Link>
                ) : null}
                {!n.readAt ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => readOne.mutate(n.id)}
                  >
                    Mark read
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {feed.hasNextPage ? (
        <div className="text-center">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void feed.fetchNextPage()}
            loading={feed.isFetchingNextPage}
          >
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

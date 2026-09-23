'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type {
  AssignmentDto,
  ConversationDto,
  InvitedTenderDto,
  NotificationDto,
  Page,
  PurchaseOrderDto,
} from '@simplexd/contracts';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  formatDateTimeLabel,
} from '@simplexd/ui';
import { describeApiFailure, partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { partnerModules } from '@/lib/partner/nav';
import { useDrafts } from '@/lib/partner/offline/use-draft-store';

function Tile({
  title,
  href,
  count,
  description,
  state,
}: {
  title: string;
  href: string;
  count: number | null;
  description: ReactNode;
  state: 'ok' | 'loading' | 'error' | 'off';
}) {
  return (
    <Link
      href={href}
      className="sx-transition block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <Card className="h-full hover:bg-bg-sunken">
        <CardHeader>
          <CardDescription>{title}</CardDescription>
          <CardTitle className="text-3xl">
            {state === 'loading' ? (
              <span className="text-fg-muted">…</span>
            ) : state === 'ok' && count !== null ? (
              count
            ) : (
              <span className="text-base font-normal text-fg-muted">n/a</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">{description}</CardContent>
      </Card>
    </Link>
  );
}

function stateOf(q: { isPending: boolean; isError: boolean }): 'ok' | 'loading' | 'error' {
  return q.isPending ? 'loading' : q.isError ? 'error' : 'ok';
}

export function PartnerHome() {
  const p = usePartner();
  const modules = partnerModules(p);
  const { drafts } = useDrafts(p.userId);
  const assignments = useQuery({
    queryKey: ['partner', 'assignments', 'proposed'],
    queryFn: () =>
      partnerFetch<Page<AssignmentDto>>(
        withQuery('/api/v1/assignments/mine', { status: 'proposed', limit: 50 }),
      ),
  });
  const tenders = useQuery({
    queryKey: ['partner', 'tenders', 'mine', 'home'],
    queryFn: () =>
      partnerFetch<Page<InvitedTenderDto>>(withQuery('/api/v1/tenders/mine', { limit: 50 })),
    enabled: modules.has('tenders'),
  });
  const orders = useQuery({
    queryKey: ['partner', 'orders', 'issued'],
    queryFn: () =>
      partnerFetch<Page<PurchaseOrderDto>>(
        withQuery('/api/v1/purchase-orders', { status: 'issued', limit: 50 }),
      ),
    enabled: modules.has('rfqs'),
  });
  const notifications = useQuery({
    queryKey: ['partner', 'notifications', 'unread'],
    queryFn: () =>
      partnerFetch<{ items: NotificationDto[]; unreadCount: number }>(
        withQuery('/api/v1/notifications', { unreadOnly: 'true', limit: 5 }),
      ),
  });
  const conversations = useQuery({
    queryKey: ['partner', 'conversations', 'open'],
    queryFn: () =>
      partnerFetch<Page<ConversationDto>>(
        withQuery('/api/v1/conversations', { status: 'open', limit: 50 }),
      ),
  });

  const unsynced = drafts.filter((d) => d.syncState !== 'synced');
  const openTenders = (tenders.data?.items ?? []).filter(
    (t) => ['published', 'clarifications'].includes(t.status) && t.invitation.status !== 'declined',
  );
  const nextDeadline = openTenders
    .map((t) => t.timeline.effectiveSubmissionDeadlineAt)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  const unreadMessages = (conversations.data?.items ?? []).reduce((n, c) => n + c.unreadCount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${p.displayName ?? p.name}`}
        description="What needs you, what is due and what happens next. Every number opens the records behind it."
      />
      {unsynced.length > 0 ? (
        <Alert
          tone="warning"
          title={`${unsynced.length} field draft${unsynced.length === 1 ? '' : 's'} not yet on the server`}
        >
          Drafts stay encrypted on this device until you sync them.{' '}
          <Link href="/partner/visits" className="font-medium underline">
            Open visits to sync
          </Link>
          .
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          title="Assignments awaiting your answer"
          href="/partner/assignments"
          count={assignments.data?.items.length ?? null}
          state={stateOf(assignments)}
          description={
            assignments.isError
              ? describeApiFailure(assignments.error).title
              : 'Accept or decline proposed work.'
          }
        />
        {modules.has('tenders') ? (
          <Tile
            title="Open tenders you are invited to"
            href="/partner/tenders"
            count={tenders.isError ? null : openTenders.length}
            state={tenders.isError ? 'error' : stateOf(tenders)}
            description={
              tenders.isError
                ? describeApiFailure(tenders.error).title
                : nextDeadline
                  ? `Next deadline ${formatDateTimeLabel(nextDeadline, p.timeZone)}`
                  : 'No submission deadline pending.'
            }
          />
        ) : null}
        {modules.has('rfqs') ? (
          <Tile
            title="Purchase orders to acknowledge"
            href="/partner/rfqs?tab=orders"
            count={orders.isError ? null : (orders.data?.items.length ?? null)}
            state={orders.isError ? 'error' : stateOf(orders)}
            description={
              orders.isError
                ? describeApiFailure(orders.error).title
                : 'Issued orders naming you as supplier.'
            }
          />
        ) : null}
        <Tile
          title="Unsynced field drafts"
          href="/partner/visits"
          count={unsynced.length}
          state="ok"
          description="Encrypted on this device; cleared only after the server confirms."
        />
        <Tile
          title="Unread notifications"
          href="/partner/notifications"
          count={notifications.data?.unreadCount ?? null}
          state={stateOf(notifications)}
          description={
            notifications.isError
              ? describeApiFailure(notifications.error).title
              : 'Awards, assignments, answers and reviews.'
          }
        />
        <Tile
          title="Unread messages"
          href="/partner/messages"
          count={conversations.isError ? null : unreadMessages}
          state={stateOf(conversations)}
          description={
            conversations.isError
              ? describeApiFailure(conversations.error).title
              : 'Conversations you take part in.'
          }
        />
      </div>
    </div>
  );
}

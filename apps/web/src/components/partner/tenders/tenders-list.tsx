'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { AwardOutcomeDto, BidDto, InvitedTenderDto, Page } from '@simplexd/contracts';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  formatNairaString,
  humanize,
} from '@simplexd/ui';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { DeadlineCountdown, DualTime, LoadingBlock, RequestFailed } from '../common';

export function TendersList() {
  const p = usePartner();
  const tenders = useQuery({
    queryKey: ['partner', 'tenders', 'mine'],
    queryFn: () =>
      partnerFetch<Page<InvitedTenderDto>>(withQuery('/api/v1/tenders/mine', { limit: 100 })),
  });
  const bids = useQuery({
    queryKey: ['partner', 'bids', 'mine'],
    queryFn: () => partnerFetch<Page<BidDto>>(withQuery('/api/v1/bids/mine', { limit: 100 })),
  });
  const awards = useQuery({
    queryKey: ['partner', 'awards', 'mine'],
    queryFn: () =>
      partnerFetch<Page<AwardOutcomeDto>>(withQuery('/api/v1/tenders/mine/awards', { limit: 100 })),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenders & bids"
        description="Tenders you were invited to, your own submissions and published award decisions. You never see another bidder's submission, and awards appear only once staff publish them."
      />
      <Tabs defaultValue="invited">
        <TabsList aria-label="Tender views">
          <TabsTrigger value="invited">Invited tenders</TabsTrigger>
          <TabsTrigger value="bids">My submissions</TabsTrigger>
          <TabsTrigger value="awards">Awards</TabsTrigger>
        </TabsList>
        <TabsContent value="invited" className="pt-4">
          {tenders.isPending ? (
            <LoadingBlock label="Loading invited tenders" />
          ) : tenders.isError ? (
            <RequestFailed
              error={tenders.error}
              onRetry={() => void tenders.refetch()}
              context="Invited tenders"
            />
          ) : tenders.data.items.length === 0 ? (
            <EmptyState
              title="No invitations yet"
              description="When staff invite you to a sealed tender it appears here with its timeline in the tender's time zone and in UTC."
            />
          ) : (
            <DataTable
              caption="Invited tenders"
              rows={tenders.data.items}
              rowKey={(t) => t.id}
              rowLabel={(t) => t.title}
              columns={[
                {
                  key: 'title',
                  header: 'Tender',
                  cell: (t) => (
                    <div>
                      <Link
                        href={`/partner/tenders/${t.id}`}
                        className="font-medium text-primary underline"
                      >
                        {t.title}
                      </Link>
                      <div className="text-xs text-fg-muted">{t.reference}</div>
                    </div>
                  ),
                },
                { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
                {
                  key: 'invitation',
                  header: 'Invitation',
                  cell: (t) => (
                    <Badge tone={t.invitation.status === 'declined' ? 'neutral' : 'info'}>
                      {humanize(t.invitation.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'deadline',
                  header: `Submission deadline (${t0(tenders.data.items)})`,
                  cell: (t) => (
                    <div className="space-y-1">
                      <DualTime
                        iso={t.timeline.effectiveSubmissionDeadlineAt}
                        zone={t.displayTimeZone}
                      />
                      {['published', 'clarifications'].includes(t.status) ? (
                        <DeadlineCountdown deadlineIso={t.timeline.effectiveSubmissionDeadlineAt} />
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'bid',
                  header: 'My bid',
                  cell: (t) =>
                    t.myBid ? (
                      <StatusBadge status={t.myBid.status} />
                    ) : (
                      <span className="text-fg-muted">Not started</span>
                    ),
                },
              ]}
            />
          )}
        </TabsContent>
        <TabsContent value="bids" className="pt-4">
          {bids.isPending ? (
            <LoadingBlock label="Loading bids" />
          ) : bids.isError ? (
            <RequestFailed
              error={bids.error}
              onRetry={() => void bids.refetch()}
              context="My submissions"
            />
          ) : bids.data.items.length === 0 ? (
            <EmptyState
              title="No bids yet"
              description="Open an invited tender and start a bid. Drafts stay private until you submit."
            />
          ) : (
            <DataTable
              caption="My bids"
              rows={bids.data.items}
              rowKey={(b) => b.id}
              rowLabel={(b) => `Bid ${b.id.slice(0, 8)}`}
              columns={[
                {
                  key: 'tender',
                  header: 'Tender',
                  cell: (b) => (
                    <Link
                      href={`/partner/tenders/${b.tenderId}/bid`}
                      className="font-medium text-primary underline"
                    >
                      Open bid workspace
                    </Link>
                  ),
                },
                { key: 'status', header: 'Status', cell: (b) => <StatusBadge status={b.status} /> },
                {
                  key: 'amount',
                  header: 'Amount',
                  cell: (b) =>
                    b.latestRevision ? formatNairaString(b.latestRevision.amountKobo) : '—',
                },
                { key: 'version', header: 'Revision', cell: (b) => `v${b.currentVersion}` },
                {
                  key: 'submitted',
                  header: 'Submitted',
                  cell: (b) => <DualTime iso={b.submittedAt} zone={p.timeZone} />,
                },
              ]}
            />
          )}
        </TabsContent>
        <TabsContent value="awards" className="pt-4">
          {awards.isPending ? (
            <LoadingBlock label="Loading awards" />
          ) : awards.isError ? (
            <RequestFailed
              error={awards.error}
              onRetry={() => void awards.refetch()}
              context="Awards"
            />
          ) : awards.data.items.length === 0 ? (
            <EmptyState
              title="No published awards"
              description="Award decisions are listed here only after staff publish them. Until then nothing about the evaluation is visible."
            />
          ) : (
            <DataTable
              caption="Award outcomes"
              rows={awards.data.items}
              rowKey={(a) => a.tenderId}
              rowLabel={(a) => a.tenderTitle}
              columns={[
                {
                  key: 'tender',
                  header: 'Tender',
                  cell: (a) => (
                    <Link
                      href={`/partner/tenders/${a.tenderId}`}
                      className="font-medium text-primary underline"
                    >
                      {a.tenderTitle}
                    </Link>
                  ),
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (a) => (
                    <Badge tone={a.outcome === 'awarded' ? 'success' : 'neutral'}>
                      {humanize(a.outcome)}
                    </Badge>
                  ),
                },
                {
                  key: 'value',
                  header: 'Contract value',
                  cell: (a) =>
                    a.award?.contractValueKobo ? formatNairaString(a.award.contractValueKobo) : '—',
                },
                {
                  key: 'published',
                  header: 'Published',
                  cell: (a) => <DualTime iso={a.publishedAt} zone={p.timeZone} />,
                },
              ]}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function t0(items: InvitedTenderDto[]): string {
  const zones = new Set(items.map((t) => t.displayTimeZone));
  return zones.size === 1 ? [...zones][0]! : 'tender zone';
}

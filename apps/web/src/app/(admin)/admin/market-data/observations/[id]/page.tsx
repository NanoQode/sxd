import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '@simplexd/contracts';
import { hasStaffPermission } from '@simplexd/domain/authz';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  PageHeader,
  StatusBadge,
  type Column,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listAuditForEntity } from '@/server/admin/audit/list';
import { adminContext } from '@/server/admin/context';
import {
  getObservation,
  type InterpretationDto,
  type ReviewDto,
} from '@/server/admin/market-data/observations';
import { AuditTable } from '../../../_components/audit-table';
import { DefinitionList, fmtDate, fmtDay } from '../../../_components/bits';
import { ReviewActions } from '../../_components/review-actions';
import { humanize } from '../../_lib/params';

export const metadata: Metadata = { title: 'Observation' };
export const dynamic = 'force-dynamic';

export default async function ObservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const identity = await requireStaffPage('market_data.read_drafts');
  const ctx = adminContext(identity);
  let o;
  try {
    o = await getObservation(ctx, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') notFound();
    throw err;
  }
  const canHistory =
    hasStaffPermission(identity.actor, 'market_data.history.read') ||
    hasStaffPermission(identity.actor, 'audit.read');
  const audit = canHistory ? await listAuditForEntity(ctx, 'observation', id) : [];
  const canPublish = hasStaffPermission(identity.actor, 'market_data.publish');
  const canEdit = hasStaffPermission(identity.actor, 'market_data.edit');
  const i = o.interpretation;
  const value =
    o.value !== null
      ? `${o.value.toLocaleString('en-NG')} ${o.unit}`
      : o.valueLow !== null || o.valueHigh !== null
        ? `${o.valueLow ?? '?'}–${o.valueHigh ?? '?'} ${o.unit}`
        : (o.valueText ?? '—');

  const historyColumns: Column<InterpretationDto>[] = [
    {
      key: 'v',
      header: 'Version',
      cell: (h) => (
        <span className="font-mono">
          v{h.version}
          {h.isCurrent ? ' (current)' : ''}
        </span>
      ),
    },
    {
      key: 'review',
      header: 'Review',
      cell: (h) =>
        humanize(
          h.reviewStatus === 'source_read_pending_business_review'
            ? 'pending review'
            : h.reviewStatus,
        ),
    },
    { key: 'pub', header: 'Publication', cell: (h) => <StatusBadge status={h.publicationState} /> },
    {
      key: 'rank',
      header: 'Rank-eligible',
      cell: (h) =>
        h.rankEligible
          ? 'Yes'
          : `No${h.reasonNotRankEligible ? `: ${h.reasonNotRankEligible}` : ''}`,
    },
    {
      key: 'note',
      header: 'Editorial note',
      hideOnMobile: true,
      cell: (h) => <span className="text-xs">{h.editorialNote ?? '—'}</span>,
    },
    {
      key: 'by',
      header: 'By',
      cell: (h) => (
        <span className="text-xs">
          {h.createdByName ?? h.createdBy ?? 'import'}
          <span className="block text-fg-muted">{fmtDate(h.createdAt)}</span>
        </span>
      ),
    },
  ];
  const reviewColumns: Column<ReviewDto>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (r) => <span className="text-xs">{fmtDate(r.createdAt)}</span>,
    },
    { key: 'who', header: 'Reviewer', cell: (r) => r.reviewerName ?? r.reviewerId },
    {
      key: 'decision',
      header: 'Decision',
      cell: (r) => (
        <Badge
          tone={
            r.decision === 'publish' || r.decision === 'approve'
              ? 'success'
              : r.decision === 'reject'
                ? 'danger'
                : 'neutral'
          }
        >
          {humanize(r.decision)}
        </Badge>
      ),
    },
    { key: 'note', header: 'Note', cell: (r) => r.note ?? '—' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${o.metric} · ${o.propertyCohort}`}
        eyebrow={`${humanize(o.geographyLevel)} · ${o.marketName ?? o.stateName ?? o.geographyLabel}`}
        description={`${humanize(o.statistic)} from ${o.source.title}`}
      />
      {o.geographyLevel === 'state_or_fct' ? (
        <Alert tone="info">
          Statewide context: shown alongside markets in this state, never as a city value and never
          rank-eligible.
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Observation (immutable)</CardTitle>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                { term: 'Value', value: <strong>{value}</strong> },
                {
                  term: 'Representation',
                  value: `${humanize(o.numericRepresentation)}${o.currency ? ` · ${o.currency}` : ''}`,
                },
                {
                  term: 'Observation period',
                  value:
                    o.observationPeriodStart || o.observationPeriodEnd
                      ? `${fmtDay(o.observationPeriodStart)} → ${fmtDay(o.observationPeriodEnd)}${o.periodCompleteAtRetrieval === false ? ' (incomplete at retrieval)' : ''}`
                      : null,
                },
                { term: 'Retrieved', value: fmtDay(o.retrievedAt) },
                { term: 'Source updated', value: fmtDay(o.sourceUpdatedAt) },
                { term: 'Valid until', value: fmtDay(o.validUntil) },
                { term: 'Sample size', value: o.sampleSize },
                { term: 'Collection method', value: humanize(o.collectionMethod) },
                {
                  term: 'Source',
                  value: (
                    <>
                      {o.source.title} <span className="text-fg-muted">({o.source.slug})</span>
                      {o.source.url ? (
                        <>
                          {' '}
                          ·{' '}
                          <a
                            className="text-primary underline"
                            href={o.source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            link
                          </a>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  term: 'License',
                  value: `${humanize(o.source.licenseRights)}${o.source.licenseNote ? ` · ${o.source.licenseNote}` : ''}${o.licenseNote ? ` · ${o.licenseNote}` : ''}`,
                },
                { term: 'Source geography label', value: o.geographyLabel },
                {
                  term: 'Market',
                  value: o.marketName ? (
                    <Link
                      className="text-primary underline"
                      href={`/admin/market-data/markets/${o.effectiveMarketId}`}
                    >
                      {o.marketName}
                    </Link>
                  ) : null,
                },
                {
                  term: 'Recorded by',
                  value: `${o.createdByName ?? o.createdBy ?? 'import'} · ${fmtDate(o.createdAt)}`,
                },
                { term: 'Slug', value: o.slug },
              ]}
            />
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Current interpretation v{i.version}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1">
                <Badge
                  tone={
                    i.reviewStatus === 'verified'
                      ? 'success'
                      : i.reviewStatus === 'rejected'
                        ? 'danger'
                        : 'info'
                  }
                >
                  {humanize(
                    i.reviewStatus === 'source_read_pending_business_review'
                      ? 'pending review'
                      : i.reviewStatus,
                  )}
                </Badge>
                <StatusBadge status={i.publicationState} />
                {i.rankEligible ? (
                  <Badge tone="gold">Rank-eligible</Badge>
                ) : (
                  <Badge tone="neutral">Not rank-eligible</Badge>
                )}
              </div>
              <DefinitionList
                items={[
                  {
                    term: 'Reason not rank-eligible',
                    value: i.rankEligible ? null : i.reasonNotRankEligible,
                  },
                  { term: 'Editorial note', value: i.editorialNote },
                  { term: 'Submitted by', value: i.createdByName ?? i.createdBy },
                  { term: 'Reviewer', value: i.reviewerName },
                  { term: 'Published', value: fmtDate(i.publishedAt) },
                ]}
              />
              <ReviewActions
                target={{
                  id: o.id,
                  metric: o.metric,
                  statistic: o.statistic,
                  geographyLevel: o.geographyLevel,
                  interpretation: i,
                  createdBy: o.createdBy,
                }}
                actorId={identity.session!.user.id}
                canPublish={canPublish}
                canEdit={canEdit}
                comparables={o.comparables}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Publication policy</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {o.comparables.applicable ? (
                <DefinitionList
                  items={[
                    {
                      term: 'Deduplicated local comparables',
                      value: `${o.comparables.count} of ${o.comparables.minComparables} required`,
                    },
                    {
                      term: 'Source concentration',
                      value:
                        o.comparables.sourceConcentration === null
                          ? null
                          : `${Math.round(o.comparables.sourceConcentration * 100)}%${o.comparables.largestSourceTitle ? ` (${o.comparables.largestSourceTitle})` : ''}`,
                    },
                    {
                      term: 'Local median publishable',
                      value: o.comparables.satisfied ? 'Yes' : 'Only as contextual evidence',
                    },
                  ]}
                />
              ) : (
                <p className="text-fg-muted">
                  The comparables threshold applies to local medians only; this observation is{' '}
                  {o.statistic} at {humanize(o.geographyLevel)} level.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Interpretation history</h2>
        <DataTable
          columns={historyColumns}
          rows={o.history}
          rowKey={(h) => h.id}
          rowLabel={(h) => `Version ${h.version}`}
          caption="Interpretation versions"
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Reviews</h2>
        <DataTable
          columns={reviewColumns}
          rows={o.reviews}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.decision}
          caption="Review decisions"
          emptyMessage="No reviews yet."
        />
      </section>
      {canHistory ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Audit</h2>
          <AuditTable items={audit} caption="Audit entries for this observation" />
        </section>
      ) : null}
    </div>
  );
}

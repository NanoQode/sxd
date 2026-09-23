import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '@simplexd/contracts';
import { hasStaffPermission } from '@simplexd/domain/authz';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  StatusBadge,
} from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { renderMarkdown } from '@/lib/markdown';
import { listAuditForEntity } from '@/server/admin/audit/list';
import { adminContext } from '@/server/admin/context';
import { listCoverage } from '@/server/admin/market-data/coverage';
import { listFlags } from '@/server/admin/market-data/flags';
import { getMarket, listMarketOptions, listRevisions } from '@/server/admin/market-data/markets';
import { listNeighborhoods } from '@/server/admin/market-data/neighborhoods';
import { listObservationsForMarket } from '@/server/admin/market-data/observations';
import { listResearchTasks, listStaffDirectory } from '@/server/admin/market-data/research-tasks';
import { listSources } from '@/server/admin/market-data/sources';
import { listSupplierLeads } from '@/server/admin/market-data/suppliers';
import { AuditTable } from '../../../_components/audit-table';
import { DefinitionList, fmtDate } from '../../../_components/bits';
import { ObservationTable } from '../../_components/observation-table';
import { humanize } from '../../_lib/params';
import { CoverageEditor } from './_components/coverage-editor';
import { FlagsTab } from './_components/flags-tab';
import { MarketTabs } from './_components/market-tabs';
import { NeighborhoodsTab } from './_components/neighborhoods-tab';
import { ProfileActions } from './_components/profile-actions';
import { ResearchTasksTab } from './_components/research-tasks-tab';
import { RevisionsTab } from './_components/revisions-tab';
import { SuppliersTab } from './_components/suppliers-tab';

export const metadata: Metadata = { title: 'Market' };
export const dynamic = 'force-dynamic';

export default async function MarketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const identity = await requireStaffPage('market_data.read_drafts');
  const ctx = adminContext(identity);
  let market;
  try {
    market = await getMarket(ctx, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') notFound();
    throw err;
  }
  const canEdit = hasStaffPermission(identity.actor, 'market_data.edit');
  const canPublish = hasStaffPermission(identity.actor, 'market_data.publish');
  const canHistory = hasStaffPermission(identity.actor, 'market_data.history.read');
  const canAudit = hasStaffPermission(identity.actor, 'audit.read') || canHistory;
  const [
    observations,
    suppliers,
    coverage,
    neighborhoods,
    flags,
    tasks,
    revisions,
    sources,
    staff,
    marketOptions,
    audit,
  ] = await Promise.all([
    listObservationsForMarket(ctx, id),
    listSupplierLeads(ctx, id),
    listCoverage(ctx, id),
    listNeighborhoods(ctx, id),
    listFlags(ctx, id),
    listResearchTasks(ctx, id),
    canHistory ? listRevisions(ctx, id) : Promise.resolve([]),
    listSources(ctx),
    listStaffDirectory(ctx),
    listMarketOptions(ctx),
    canAudit ? listAuditForEntity(ctx, 'market', id) : Promise.resolve([]),
  ]);
  const actorId = identity.session!.user.id;
  const sourceOptions = sources.map((s) => ({ id: s.id, title: s.title }));

  const profile = (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <DefinitionList
            items={[
              { term: 'Slug', value: <code className="font-mono text-xs">{market.slug}</code> },
              {
                term: 'Aliases',
                value: market.aliases.length > 0 ? market.aliases.join(', ') : null,
              },
              { term: 'State / zone', value: `${market.stateName} (${market.geopoliticalZone})` },
              {
                term: 'Parent market',
                value: market.parent ? (
                  <Link
                    className="text-primary underline"
                    href={`/admin/market-data/markets/${market.parent.id}`}
                  >
                    {market.parent.name}
                  </Link>
                ) : null,
              },
              { term: 'Overlap note', value: market.overlapNote },
              {
                term: 'Reference point',
                value: `${market.location.lon}, ${market.location.lat} (lon, lat)${market.coordinateAccuracy ? ` · ${market.coordinateAccuracy}` : ''}`,
              },
              { term: 'Coordinate source', value: market.coordinateSource?.title ?? null },
              { term: 'Selection basis', value: market.selectionBasis },
              { term: 'Supply mapping method', value: market.supplyMappingMethod },
              { term: 'Recommendation status', value: humanize(market.recommendationStatus) },
              { term: 'Last researched', value: market.lastResearchedAt },
              { term: 'Last reviewed', value: fmtDate(market.lastReviewedAt) },
              {
                term: 'Imported',
                value: market.importedAt ? `${fmtDate(market.importedAt)}` : 'Created by hand',
              },
              { term: 'Human edited', value: fmtDate(market.humanEditedAt) },
              {
                term: 'Linked records',
                value: `${market.linkedProjects} projects · ${market.linkedProperties} properties · ${market.linkedServiceRequests} requests`,
              },
            ]}
          />
          {market.profileMarkdown ? (
            <div
              className="sx-prose mt-6 border-t border-border pt-4 text-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(market.profileMarkdown) }}
            />
          ) : (
            <p className="mt-6 border-t border-border pt-4 text-sm text-fg-muted">
              No profile text yet.
            </p>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Publication</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={market.publicationState} />
              <Badge tone={market.serviceAvailability === 'available' ? 'success' : 'neutral'}>
                {humanize(market.serviceAvailability)}
              </Badge>
            </div>
            <DefinitionList
              items={[
                { term: 'Version', value: `v${market.version}` },
                { term: 'Published', value: fmtDate(market.publishedAt) },
                { term: 'Archived', value: fmtDate(market.archivedAt) },
                {
                  term: 'Merged into',
                  value: market.mergedInto ? (
                    <Link
                      className="text-primary underline"
                      href={`/admin/market-data/markets/${market.mergedInto.id}`}
                    >
                      {market.mergedInto.name}
                    </Link>
                  ) : null,
                },
              ]}
            />
            <p className="text-xs text-fg-muted">
              Map publication and service availability are separate decisions; a visible marker does
              not claim a staffed operation.
            </p>
            <ProfileActions
              market={{
                id: market.id,
                name: market.name,
                version: market.version,
                publicationState: market.publicationState,
                location: market.location,
                mergedIntoMarketId: market.mergedIntoMarketId,
                coordinateSourceId: market.coordinateSourceId,
                coordinateAccuracy: market.coordinateAccuracy,
                linkedProjects: market.linkedProjects,
              }}
              canEdit={canEdit}
              canPublish={canPublish}
              sources={sourceOptions}
              markets={marketOptions.filter((m) => m.id !== market.id)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Evidence at a glance</CardTitle>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                { term: 'Local observations', value: market.localObservations },
                { term: 'Statewide context', value: market.regionalContextObservations },
                { term: 'Pending review', value: market.pendingReviews },
                { term: 'Open research tasks', value: market.openResearchTasks },
                { term: 'Supplier leads', value: suppliers.leads.length },
                { term: 'Active flags', value: flags.filter((f) => f.active).length },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );

  const observationsTab = (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Local observations</h2>
        {canEdit ? (
          <Link href={`/admin/market-data/observations/new?marketId=${market.id}`}>
            <Button size="sm">Record observation</Button>
          </Link>
        ) : null}
      </div>
      <ObservationTable
        items={observations.local}
        actorId={actorId}
        canPublish={canPublish}
        canEdit={canEdit}
        caption="Local observations"
        showMarket={false}
        emptyMessage="No local observations. Statewide context is never cloned into city rows; record local comparables instead."
      />
      <h2 className="text-lg font-semibold">Statewide context ({market.stateName})</h2>
      <Alert tone="info">
        Statewide figures are shown as regional context and are never rank-eligible for this market.
      </Alert>
      <ObservationTable
        items={observations.statewide}
        actorId={actorId}
        canPublish={canPublish}
        canEdit={canEdit}
        caption="Statewide context observations"
        emptyMessage="No statewide observations for this state."
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={market.name}
        eyebrow={`${market.stateName} · ${market.geopoliticalZone}`}
        description={market.selectionBasis ?? undefined}
        actions={
          canEdit && !market.mergedIntoMarketId ? (
            <Link href={`/admin/market-data/markets/${market.id}/edit`}>
              <Button variant="secondary">Edit</Button>
            </Link>
          ) : undefined
        }
      />
      {market.mergedIntoMarketId ? (
        <Alert tone="warning" title="This market was merged">
          Records now apply to{' '}
          <Link
            href={`/admin/market-data/markets/${market.mergedIntoMarketId}`}
            className="font-medium text-primary underline"
          >
            {market.mergedInto?.name ?? 'the target market'}
          </Link>
          . This record is kept for history.
        </Alert>
      ) : null}
      <MarketTabs
        initialTab={tab}
        tabs={[
          { key: 'profile', label: 'Profile', content: profile },
          {
            key: 'observations',
            label: `Observations (${observations.local.length})`,
            content: observationsTab,
          },
          {
            key: 'suppliers',
            label: `Suppliers (${suppliers.leads.length})`,
            content: <SuppliersTab leads={suppliers.leads} quotes={suppliers.quotes} />,
          },
          {
            key: 'coverage',
            label: 'Coverage',
            content: <CoverageEditor marketId={market.id} rows={coverage} canEdit={canEdit} />,
          },
          {
            key: 'neighborhoods',
            label: `Neighborhoods (${neighborhoods.length})`,
            content: (
              <NeighborhoodsTab
                marketId={market.id}
                items={neighborhoods}
                sources={sourceOptions}
                canEdit={canEdit}
                canPublish={canPublish}
              />
            ),
          },
          {
            key: 'flags',
            label: `Flags (${flags.filter((f) => f.active).length})`,
            content: (
              <FlagsTab
                marketId={market.id}
                items={flags}
                sources={sourceOptions}
                neighborhoods={neighborhoods.map((n) => ({ id: n.id, name: n.name }))}
                canEdit={canEdit}
                canPublish={canPublish}
              />
            ),
          },
          {
            key: 'research',
            label: `Research (${tasks.filter((t) => t.status !== 'done').length})`,
            content: (
              <ResearchTasksTab
                marketId={market.id}
                items={tasks}
                staff={staff}
                canEdit={canEdit}
              />
            ),
          },
          {
            key: 'revisions',
            label: `Revisions (${revisions.length})`,
            content: canHistory ? (
              <RevisionsTab
                marketId={market.id}
                currentVersion={market.version}
                items={revisions}
                canEdit={market.publicationState === 'published' ? canPublish : canEdit}
              />
            ) : (
              <Alert tone="info">You do not have permission to read revision history.</Alert>
            ),
          },
          {
            key: 'audit',
            label: 'Audit',
            content: canAudit ? (
              <AuditTable items={audit} caption={`Audit entries for ${market.name}`} />
            ) : (
              <Alert tone="info">You do not have permission to read the audit log.</Alert>
            ),
          },
        ]}
      />
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EmptyState, PageHeader, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { requireSignedIn, type RequestIdentity } from '@/lib/auth/session';
import { capabilityNote, customerCapabilities, type CustomerCapabilities } from '@/lib/portal/server/permissions';
import { buildPropertyTimeline, listPropertyProjects, listPropertyVisits } from '@/lib/portal/server/properties';
import { FilesPanel } from '@/components/portal/files-panel';
import { NotesPanel } from '@/components/portal/notes-panel';
import { EditPropertyButton, OwnerAuthorityPanel, ParcelsPanel, UnitsPanel } from '@/components/portal/property-panels';
import { SectionTabs, resolveTab } from '@/components/portal/section-tabs';
import { Timeline } from '@/components/portal/timeline';
import { listFilesForEntity } from '@/server/files/queries';
import { listNotes } from '@/server/notes/service';
import { listOwnerAuthorities } from '@/server/properties/owner-authorities';
import { listParcels } from '@/server/properties/parcels';
import { getPropertyOverview } from '@/server/properties/service';
import { listUnits } from '@/server/properties/units';

export const metadata: Metadata = { title: 'Property' };
export const dynamic = 'force-dynamic';

const TABS = ['overview', 'units', 'projects', 'documents', 'visits', 'timeline'] as const;

const TITLE_COPY: Record<string, string> = {
  unknown: 'Title has not been checked. This is what we know today, not a verdict.',
  documents_received: 'Documents were received; verification has not started.',
  verification_in_progress: 'Verification is under way at the relevant registry.',
  verified: 'Title was verified; the report states what was checked and when.',
  issues_found: 'Verification found issues; see the diligence report before acting.',
  disputed: 'The title is disputed; seek legal advice before any transaction.',
};

export default async function PropertyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/properties/${id}`);
  const overview = await getPropertyOverview(identity, id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden')) return null;
    throw err;
  });
  if (!overview) notFound();
  const tab = resolveTab(tabParam, TABS);
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity, overview.property.organizationId);
  const p = overview.property;
  const basePath = `/portal/properties/${id}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/properties" className="underline">
            Properties
          </Link>
        }
        title={p.name}
        description={`${humanize(p.kind)}${p.address?.city ? ` · ${[p.address.line1, p.address.city, p.address.state].filter(Boolean).join(', ')}` : ''}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} />
            <EditPropertyButton property={p} canManage={caps.manageProperties && p.status === 'active'} />
          </span>
        }
      />
      <SectionTabs
        basePath={basePath}
        active={tab}
        label="Property sections"
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'units', label: 'Units', badge: overview.units.total > 0 ? <Badge tone="neutral">{overview.units.total}</Badge> : undefined },
          { value: 'projects', label: 'Projects', badge: overview.linkedProjectsCount > 0 ? <Badge tone="neutral">{overview.linkedProjectsCount}</Badge> : undefined },
          { value: 'documents', label: 'Documents', badge: overview.documents.pending > 0 ? <Badge tone="warning">{overview.documents.pending} scanning</Badge> : undefined },
          { value: 'visits', label: 'Inspections' },
          { value: 'timeline', label: 'Timeline' },
        ]}
      />
      {tab === 'overview' ? <OverviewTab identity={identity} overview={overview} caps={caps} zone={zone} /> : null}
      {tab === 'units' ? <UnitsTab identity={identity} propertyId={id} caps={caps} zone={zone} /> : null}
      {tab === 'projects' ? <ProjectsTab identity={identity} propertyId={id} zone={zone} /> : null}
      {tab === 'documents' ? <DocumentsTab identity={identity} propertyId={id} caps={caps} zone={zone} /> : null}
      {tab === 'visits' ? <VisitsTab identity={identity} propertyId={id} zone={zone} /> : null}
      {tab === 'timeline' ? <TimelineTab identity={identity} overview={overview} zone={zone} /> : null}
    </div>
  );
}

type Overview = NonNullable<Awaited<ReturnType<typeof getPropertyOverview>>>;

async function OverviewTab({ identity, overview, caps, zone }: { identity: RequestIdentity; overview: Overview; caps: CustomerCapabilities; zone: string }) {
  const p = overview.property;
  const [parcels, authorities, notes] = await Promise.all([
    listParcels(identity, p.id),
    listOwnerAuthorities(identity, p.id),
    listNotes(identity, { entityType: 'property', entityId: p.id, limit: 50 }),
  ]);
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Title status <StatusBadge status={p.titleStatus} />
            </CardTitle>
            <CardDescription>{TITLE_COPY[p.titleStatus] ?? ''}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-fg-muted">Title type</dt>
                <dd>{p.titleType ?? 'Not recorded'}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Land area (as declared)</dt>
                <dd>
                  {p.landArea ? (
                    <>
                      {p.landArea.declaredValue} {p.landArea.declaredUnit}
                      {p.landArea.m2 ? <span className="text-fg-muted"> · {p.landArea.m2} m²</span> : <span className="text-fg-muted"> · not converted (plot sizes vary)</span>}
                    </>
                  ) : (
                    'Not declared'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Floor area</dt>
                <dd>{p.floorAreaM2 ? `${p.floorAreaM2} m²` : 'Not declared'}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Location</dt>
                <dd>{p.location ? `${p.location.lat.toFixed(5)}, ${p.location.lon.toFixed(5)}${p.preciseLocationPublic ? '' : ' (private)'}` : 'No coordinates recorded'}</dd>
              </div>
            </dl>
            {p.titleNote ? <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">{p.titleNote}</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-6 pt-5">
            <ParcelsPanel propertyId={p.id} parcels={parcels} canManage={caps.manageProperties} />
            <OwnerAuthorityPanel propertyId={p.id} authorities={authorities} canManage={caps.manageProperties && caps.uploadDocuments} zone={zone} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <NotesPanel entityType="property" entityId={p.id} notes={notes.items} zone={zone} />
          </CardContent>
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Occupancy</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-muted">Units</dt>
              <dd>{overview.units.total}</dd>
              <dt className="text-fg-muted">Occupied</dt>
              <dd>{overview.units.occupied}</dd>
              <dt className="text-fg-muted">Vacant</dt>
              <dd>{overview.units.vacant}</dd>
              <dt className="text-fg-muted">Occupancy</dt>
              <dd>{overview.units.occupancyPercent === null ? 'No units' : `${overview.units.occupancyPercent}%`}</dd>
              <dt className="text-fg-muted">Parcels</dt>
              <dd>{overview.parcelsCount}</dd>
              <dt className="text-fg-muted">Linked projects</dt>
              <dd>{overview.linkedProjectsCount}</dd>
              <dt className="text-fg-muted">Documents</dt>
              <dd>
                {overview.documents.available} available{overview.documents.pending > 0 ? `, ${overview.documents.pending} scanning` : ''}
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Owner authority</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {overview.ownerAuthority ? (
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge status={overview.ownerAuthority.effectiveStatus} />
                {overview.ownerAuthority.expiresAt ? <span className="text-fg-muted">expires {formatDateTimeLabel(overview.ownerAuthority.expiresAt, zone)}</span> : null}
              </p>
            ) : (
              <p className="text-fg-muted">None on file.</p>
            )}
          </CardContent>
        </Card>
        {!caps.manageProperties ? <p className="text-xs text-fg-muted">{capabilityNote(caps, 'Editing this property')}</p> : null}
      </div>
    </div>
  );
}

async function UnitsTab({ identity, propertyId, caps, zone }: { identity: RequestIdentity; propertyId: string; caps: CustomerCapabilities; zone: string }) {
  const units = await listUnits(identity, propertyId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Units</CardTitle>
        <CardDescription>Flats, shops, rooms or plots within this property. Labels are unique per property.</CardDescription>
      </CardHeader>
      <CardContent>
        <UnitsPanel propertyId={propertyId} units={units} canManage={caps.manageProperties} zone={zone} />
      </CardContent>
    </Card>
  );
}

async function ProjectsTab({ identity, propertyId, zone }: { identity: RequestIdentity; propertyId: string; zone: string }) {
  const projects = await listPropertyProjects(identity, propertyId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects on this property</CardTitle>
      </CardHeader>
      <CardContent>
        {projects.length === 0 ? (
          <EmptyState title="No projects linked" description="Monitoring, design and renovation projects on this property appear here once the team opens them." />
        ) : (
          <DataTable
            caption="Linked projects"
            rows={projects}
            rowKey={(p) => p.id}
            rowLabel={(p) => p.name}
            columns={[
              {
                key: 'name',
                header: 'Project',
                cell: (p) => (
                  <Link href={`/portal/projects/${p.id}`} className="font-medium text-primary underline">
                    {p.name}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (p) => humanize(p.kind) },
              { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'completion', header: 'Completion', cell: (p) => p.forecastCompletionDate ?? p.targetCompletionDate ?? '—' },
              { key: 'updated', header: 'Updated', cell: (p) => formatDateTimeLabel(p.updatedAt, zone), hideOnMobile: true },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

async function DocumentsTab({ identity, propertyId, caps, zone }: { identity: RequestIdentity; propertyId: string; caps: CustomerCapabilities; zone: string }) {
  const page = await listFilesForEntity(identity, { entityType: 'property', entityId: propertyId, limit: 100 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <CardDescription>Title documents, survey plans and letters for this property. Everything is scanned before it can be opened.</CardDescription>
      </CardHeader>
      <CardContent>
        <FilesPanel files={page.items} entityType="property" entityId={propertyId} purpose="org_document" zone={zone} canUpload={caps.uploadDocuments} cannotUploadReason={capabilityNote(caps, 'Uploading documents')} />
      </CardContent>
    </Card>
  );
}

async function VisitsTab({ identity, propertyId, zone }: { identity: RequestIdentity; propertyId: string; zone: string }) {
  const visits = await listPropertyVisits(identity, propertyId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inspections and visits</CardTitle>
        <CardDescription>Site visits the team scheduled on this property; findings are released through reports.</CardDescription>
      </CardHeader>
      <CardContent>
        {visits.length === 0 ? (
          <EmptyState title="No visits recorded" description="Inspections booked on a project or request that name this property appear here." />
        ) : (
          <DataTable
            caption="Site visits"
            rows={visits}
            rowKey={(v) => v.id}
            rowLabel={(v) => `Visit ${v.scheduledAt ? formatDateTimeLabel(v.scheduledAt, zone) : v.id.slice(0, 8)}`}
            columns={[
              { key: 'when', header: 'Scheduled', cell: (v) => (v.scheduledAt ? formatDateTimeLabel(v.scheduledAt, zone) : '—') },
              { key: 'status', header: 'Status', cell: (v) => <StatusBadge status={v.status} /> },
              { key: 'inspector', header: 'Inspector', cell: (v) => v.inspectorName ?? '—' },
              { key: 'submitted', header: 'Submitted', cell: (v) => (v.submittedAt ? formatDateTimeLabel(v.submittedAt, zone) : '—'), hideOnMobile: true },
              {
                key: 'project',
                header: 'Project',
                cell: (v) =>
                  v.projectId ? (
                    <Link href={`/portal/projects/${v.projectId}?tab=timeline`} className="text-primary underline">
                      Open project
                    </Link>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

async function TimelineTab({ identity, overview, zone }: { identity: RequestIdentity; overview: Overview; zone: string }) {
  const id = overview.property.id;
  const [units, authorities, projects, visits] = await Promise.all([
    listUnits(identity, id),
    listOwnerAuthorities(identity, id),
    listPropertyProjects(identity, id),
    listPropertyVisits(identity, id),
  ]);
  const events = buildPropertyTimeline({ property: overview.property, units, authorities, projects, visits });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Derived from the property&apos;s own records; the staff audit log is not part of the customer view.</CardDescription>
      </CardHeader>
      <CardContent>
        <Timeline events={events} zone={zone} />
      </CardContent>
    </Card>
  );
}

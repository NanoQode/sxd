import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatArea,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { can, requireAnyStaff, staffTx, orgNames } from '@/lib/admin/server/context';
import { propertyProjects } from '@/lib/admin/server/properties';
import { listNotes } from '@/server/notes/service';
import { listOwnerAuthorities } from '@/server/properties/owner-authorities';
import { listParcels } from '@/server/properties/parcels';
import { getPropertyOverview } from '@/server/properties/service';
import { listUnits } from '@/server/properties/units';
import { ApiAction } from '@/components/admin/api-action';
import { NotesPanel } from '@/components/admin/notes-panel';
import { Section } from '@/components/admin/section';
import { DefinitionList, StatTile } from '../../_components/bits';

export const metadata: Metadata = { title: 'Property' };
export const dynamic = 'force-dynamic';

export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSignedIn('/admin/properties');
  requireAnyStaff(identity, ['customers.read', 'projects.read_all']);
  const { id } = await params;
  let overview;
  try {
    overview = await getPropertyOverview(identity, id);
  } catch {
    notFound();
  }
  const [units, parcels, authorities, projects, notes, names] = await Promise.all([
    listUnits(identity, id),
    listParcels(identity, id),
    listOwnerAuthorities(identity, id),
    propertyProjects(identity, id),
    listNotes(identity, { entityType: 'property', entityId: id, limit: 100 })
      .then((p) => p.items)
      .catch(() => []),
    staffTx(identity, (tx) => orgNames(tx, [overview!.property.organizationId])),
  ]);
  const p = overview.property;
  const canVerify = can(identity, 'rentals.manage');
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/properties" className="underline">
            Properties
          </Link>
        }
        title={p.name}
        description={`${humanize(p.kind)} · ${names.get(p.organizationId) ?? p.organizationId}`}
        actions={
          <>
            <StatusBadge status={p.status} />
            <Badge tone="neutral">title: {humanize(p.titleStatus)}</Badge>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Units"
          value={overview.units.total}
          hint={
            overview.units.occupancyPercent !== null
              ? `${overview.units.occupancyPercent}% occupied`
              : 'No units'
          }
        />
        <StatTile label="Parcels" value={overview.parcelsCount} />
        <StatTile label="Linked projects" value={overview.linkedProjectsCount} />
        <StatTile
          label="Documents"
          value={overview.documents.available}
          hint={
            overview.documents.pending > 0
              ? `${overview.documents.pending} awaiting scan`
              : 'All scanned'
          }
          tone={overview.documents.pending > 0 ? 'warning' : 'neutral'}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section title="Details">
            <DefinitionList
              items={[
                {
                  term: 'Organisation',
                  value: (
                    <Link href={`/admin/customers/${p.organizationId}`} className="underline">
                      {names.get(p.organizationId) ?? p.organizationId}
                    </Link>
                  ),
                },
                {
                  term: 'Address',
                  value: p.address
                    ? [
                        p.address.line1,
                        p.address.line2,
                        p.address.city,
                        p.address.state,
                        p.address.country,
                      ]
                        .filter(Boolean)
                        .join(', ')
                    : null,
                },
                {
                  term: 'Land area',
                  value: p.landArea
                    ? `${p.landArea.declaredValue} ${p.landArea.declaredUnit}${p.landArea.m2 ? ` (${formatArea(p.landArea.m2)})` : ' (not convertible)'}`
                    : null,
                },
                { term: 'Floor area', value: p.floorAreaM2 ? formatArea(p.floorAreaM2) : null },
                { term: 'Title type', value: p.titleType },
                { term: 'Title note', value: p.titleNote },
                {
                  term: 'Location',
                  value: p.location
                    ? `${p.location.lat.toFixed(5)}, ${p.location.lon.toFixed(5)}${p.preciseLocationPublic ? '' : ' (precise location private)'}`
                    : null,
                },
                { term: 'Updated', value: formatDateTimeLabel(p.updatedAt) },
              ]}
            />
          </Section>
          <Section
            title={`Units (${units.length})`}
            description="Units are managed by the customer or through the property API; leases reference them."
          >
            <DataTable
              caption="Units"
              rows={units}
              rowKey={(u) => u.id}
              rowLabel={(u) => u.label}
              emptyMessage="No units declared."
              columns={[
                { key: 'label', header: 'Unit', cell: (u) => u.label },
                { key: 'type', header: 'Type', cell: (u) => u.unitType },
                {
                  key: 'beds',
                  header: 'Bed / bath',
                  cell: (u) => `${u.bedrooms ?? '—'} / ${u.bathrooms ?? '—'}`,
                },
                {
                  key: 'area',
                  header: 'Floor area',
                  cell: (u) => (u.floorAreaM2 ? formatArea(u.floorAreaM2) : '—'),
                  hideOnMobile: true,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (u) => (
                    <StatusBadge
                      status={
                        u.status === 'occupied'
                          ? 'in_progress'
                          : u.status === 'vacant'
                            ? 'open'
                            : 'disabled'
                      }
                      label={humanize(u.status)}
                    />
                  ),
                },
              ]}
            />
          </Section>
          <Section title={`Parcels (${parcels.length})`}>
            <DataTable
              caption="Parcels"
              rows={parcels}
              rowKey={(x) => x.id}
              rowLabel={(x) => x.reference ?? x.id}
              emptyMessage="No parcels recorded."
              columns={[
                { key: 'ref', header: 'Reference', cell: (x) => x.reference ?? '—' },
                { key: 'survey', header: 'Survey plan', cell: (x) => x.surveyPlanRef ?? '—' },
                {
                  key: 'area',
                  header: 'Area',
                  cell: (x) => (x.area ? `${x.area.declaredValue} ${x.area.declaredUnit}` : '—'),
                },
                {
                  key: 'boundary',
                  header: 'Boundary',
                  cell: (x) =>
                    x.boundary ? `${x.boundary.coordinates[0]?.length ?? 0} points` : 'not drawn',
                },
              ]}
            />
          </Section>
          <Section title={`Projects (${projects.length})`}>
            {projects.length === 0 ? (
              <p className="text-fg-muted">No project references this property.</p>
            ) : (
              <ul className="space-y-1">
                {projects.map((pr) => (
                  <li key={pr.id} className="flex flex-wrap justify-between gap-2">
                    <Link href={`/admin/projects/${pr.id}`} className="underline">
                      {pr.name}
                    </Link>
                    <span className="flex gap-2">
                      <span className="text-fg-muted">{humanize(pr.kind)}</span>
                      <StatusBadge status={pr.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section
            title="Owner authority"
            description="Verification needs rentals.manage. A verified authority lapses at its expiry date."
          >
            {authorities.length === 0 ? (
              <p className="text-fg-muted">No authority document submitted.</p>
            ) : (
              <ul className="space-y-2">
                {authorities.map((a) => (
                  <li key={a.id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{a.ownerName}</span>
                      <StatusBadge status={a.effectiveStatus} />
                    </div>
                    <p className="text-xs text-fg-muted">
                      Submitted {formatDateTimeLabel(a.createdAt)}
                      {a.verifiedAt ? ` · verified ${formatDateTimeLabel(a.verifiedAt)}` : ''}
                      {a.expiresAt ? ` · expires ${formatDateTimeLabel(a.expiresAt)}` : ''}
                    </p>
                    {a.authorityDocumentFileId ? (
                      <a
                        href={`/api/v1/files/${a.authorityDocumentFileId}/download`}
                        className="text-xs underline"
                      >
                        Open document
                      </a>
                    ) : null}
                    {a.note ? <p className="mt-1 text-xs">{a.note}</p> : null}
                    {canVerify && a.status === 'pending' ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <ApiAction
                          path={`/api/v1/properties/${id}/owner-authorities/${a.id}/verify`}
                          label="Verify"
                          variant="primary"
                          reasonKey="note"
                          confirm={{
                            title: 'Verify owner authority?',
                            description:
                              'Confirms the document authorises this owner. Add a note for the record.',
                            confirmLabel: 'Verify',
                          }}
                          successMessage="Authority verified"
                        />
                        <ApiAction
                          path={`/api/v1/properties/${id}/owner-authorities/${a.id}/reject`}
                          label="Reject"
                          variant="danger"
                          reasonKey="reason"
                          confirm={{
                            title: 'Reject owner authority?',
                            requireReason: true,
                            confirmLabel: 'Reject',
                            tone: 'danger',
                          }}
                          successMessage="Authority rejected"
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Notes">
            <NotesPanel entityType="property" entityId={id} notes={notes} canWrite />
          </Section>
        </div>
      </div>
    </div>
  );
}

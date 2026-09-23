import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { OwnerAuthorityDto, PropertyDto, SiteVisitDto, UnitDto } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/**
 * Property read models that no dedicated endpoint covers yet: projects linked
 * to a property, site visits on a property and a timeline assembled from the
 * customer-visible records (the append-only audit log is staff-only).
 */

export interface PropertyProjectItem {
  id: string;
  name: string;
  kind: string;
  status: string;
  targetCompletionDate: string | null;
  forecastCompletionDate: string | null;
  updatedAt: string;
}

export async function listPropertyProjects(
  identity: RequestIdentity,
  propertyId: string,
): Promise<PropertyProjectItem[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.propertyId, propertyId), isNull(schema.projects.archivedAt)))
      .orderBy(desc(schema.projects.updatedAt))
      .limit(100),
  );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    targetCompletionDate: p.targetCompletionDate,
    forecastCompletionDate: p.forecastCompletionDate,
    updatedAt: p.updatedAt.toISOString(),
  }));
}

export type PropertyVisitItem = Pick<
  SiteVisitDto,
  'id' | 'projectId' | 'scheduledAt' | 'status' | 'inspectorName' | 'submittedAt' | 'reviewedAt'
>;

export async function listPropertyVisits(
  identity: RequestIdentity,
  propertyId: string,
): Promise<PropertyVisitItem[]> {
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ v: schema.siteVisits, inspectorName: schema.user.name })
      .from(schema.siteVisits)
      .leftJoin(schema.user, eq(schema.user.id, schema.siteVisits.inspectorUserId))
      .where(eq(schema.siteVisits.propertyId, propertyId))
      .orderBy(desc(schema.siteVisits.scheduledAt))
      .limit(100),
  );
  return rows.map(({ v, inspectorName }) => ({
    id: v.id,
    projectId: v.projectId,
    scheduledAt: v.scheduledAt?.toISOString() ?? null,
    status: v.status,
    inspectorName,
    submittedAt: v.submittedAt?.toISOString() ?? null,
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
  }));
}

export interface TimelineEvent {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  kind: string;
  href?: string;
}

export function buildPropertyTimeline(input: {
  property: PropertyDto;
  units: UnitDto[];
  authorities: OwnerAuthorityDto[];
  projects: PropertyProjectItem[];
  visits: PropertyVisitItem[];
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  events.push({
    id: `created-${input.property.id}`,
    at: input.property.createdAt,
    title: 'Property record created',
    detail: `${input.property.name} was added as ${input.property.kind.replace(/_/g, ' ')}.`,
    kind: 'property',
  });
  if (input.property.updatedAt !== input.property.createdAt) {
    events.push({
      id: `updated-${input.property.id}`,
      at: input.property.updatedAt,
      title: 'Property details updated',
      detail: `Version ${input.property.version}; title status ${input.property.titleStatus.replace(/_/g, ' ')}.`,
      kind: 'property',
    });
  }
  if (input.property.archivedAt) {
    events.push({
      id: `archived-${input.property.id}`,
      at: input.property.archivedAt,
      title: 'Property archived',
      detail: null,
      kind: 'property',
    });
  }
  for (const u of input.units) {
    events.push({
      id: `unit-${u.id}`,
      at: u.createdAt,
      title: `Unit ${u.label} added`,
      detail: u.unitType,
      kind: 'unit',
    });
  }
  for (const a of input.authorities) {
    events.push({
      id: `authority-${a.id}`,
      at: a.createdAt,
      title: 'Owner authority submitted',
      detail: `${a.ownerName}; status ${a.effectiveStatus}.`,
      kind: 'authority',
    });
    if (a.verifiedAt) {
      events.push({
        id: `authority-verified-${a.id}`,
        at: a.verifiedAt,
        title: a.status === 'rejected' ? 'Owner authority rejected' : 'Owner authority verified',
        detail: a.note,
        kind: 'authority',
      });
    }
  }
  for (const p of input.projects) {
    events.push({
      id: `project-${p.id}`,
      at: p.updatedAt,
      title: `Project ${p.name} (${p.status.replace(/_/g, ' ')})`,
      detail: p.forecastCompletionDate ? `Forecast completion ${p.forecastCompletionDate}` : null,
      kind: 'project',
      href: `/portal/projects/${p.id}`,
    });
  }
  for (const v of input.visits) {
    const at = v.reviewedAt ?? v.submittedAt ?? v.scheduledAt;
    if (!at) continue;
    events.push({
      id: `visit-${v.id}`,
      at,
      title: `Site visit ${v.status.replace(/_/g, ' ')}`,
      detail: v.inspectorName ? `Inspector: ${v.inspectorName}` : null,
      kind: 'visit',
      href: v.projectId ? `/portal/projects/${v.projectId}?tab=timeline` : undefined,
    });
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

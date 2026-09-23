import 'server-only';
import { and, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  type Page,
  type PropertyArchive,
  type PropertyCreate,
  type PropertyDto,
  type PropertyListQuery,
  type PropertyOverview,
  type PropertyUpdate,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  decodeCursor,
  encodeCursor,
  isStaffIdentity,
  requireUserId,
  versionConflict,
  type ServiceOptions,
} from '@/server/assignments/shared';
import {
  assertPropertyManage,
  assertPropertyRead,
  loadProperty,
  propertyRef,
  requireProperty,
  resolveTargetOrganization,
} from './access';
import { normaliseArea } from './areas';
import { effectiveAuthorityStatus, toPropertyDto } from './dto';

type PropertyInsert = typeof schema.properties.$inferInsert;

/**
 * Private property assets. Every mutation runs inside one transaction under
 * the caller's row-level security context: the reads prove visibility, the
 * application policy authorises the action, and the writes (row plus audit
 * entry) go through the same policies. Areas keep the declared value and unit
 * verbatim next to the normalised square metres; precise coordinates stay
 * private by default.
 */

async function assertReferences(
  tx: DbExecutor,
  organizationId: string,
  input: { marketId?: string | null; neighborhoodId?: string | null; estateId?: string | null },
): Promise<void> {
  const issues: Array<{ path: string; message: string }> = [];
  if (input.marketId) {
    const [m] = await tx
      .select({ id: schema.markets.id })
      .from(schema.markets)
      .where(eq(schema.markets.id, input.marketId));
    if (!m) issues.push({ path: 'marketId', message: 'unknown market' });
  }
  if (input.neighborhoodId) {
    const [n] = await tx
      .select({ id: schema.neighborhoods.id })
      .from(schema.neighborhoods)
      .where(eq(schema.neighborhoods.id, input.neighborhoodId));
    if (!n) issues.push({ path: 'neighborhoodId', message: 'unknown neighborhood' });
  }
  if (input.estateId) {
    const [e] = await tx
      .select({ id: schema.estates.id, organizationId: schema.estates.organizationId })
      .from(schema.estates)
      .where(eq(schema.estates.id, input.estateId));
    if (!e || e.organizationId !== organizationId) {
      issues.push({ path: 'estateId', message: 'unknown estate for this organisation' });
    }
  }
  if (issues.length > 0) {
    throw new ApiError('validation_failed', 'property references could not be resolved', {
      details: issues,
    });
  }
}

function areaColumns(
  landArea: PropertyCreate['landArea'],
): Pick<PropertyInsert, 'landAreaM2' | 'landAreaDeclaredValue' | 'landAreaDeclaredUnit'> {
  if (!landArea)
    return { landAreaM2: null, landAreaDeclaredValue: null, landAreaDeclaredUnit: null };
  const n = normaliseArea(landArea);
  return {
    landAreaM2: n.m2,
    landAreaDeclaredValue: n.declaredValue,
    landAreaDeclaredUnit: n.declaredUnit,
  };
}

export async function createProperty(
  identity: RequestIdentity,
  input: PropertyCreate,
  options: ServiceOptions = {},
): Promise<PropertyDto> {
  const userId = requireUserId(identity);
  const organizationId = resolveTargetOrganization(identity, input.organizationId);
  assertPropertyManage(identity, propertyRef(organizationId));
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    await assertReferences(tx, organizationId, input);
    // NOTE: migration 0001 guards `properties` with WITH CHECK app.can_access_property(id),
    // which looks the row up in the table and therefore rejects every INSERT through the
    // runtime role (staff and bypass included). Until packages/db splits that policy into
    // read = can_access_property(id) / write = app.org_match(organization_id), this insert
    // fails with a row-level security error; nothing here can work around it.
    const [row] = await tx
      .insert(schema.properties)
      .values({
        organizationId,
        name: input.name,
        kind: input.kind,
        address: input.address ?? null,
        marketId: input.marketId ?? null,
        neighborhoodId: input.neighborhoodId ?? null,
        estateId: input.estateId ?? null,
        location: input.location ?? null,
        preciseLocationPublic: input.preciseLocationPublic,
        ...areaColumns(input.landArea),
        floorAreaM2: input.floorAreaM2 ?? null,
        titleType: input.titleType ?? null,
        titleStatus: input.titleStatus,
        titleNote: input.titleNote ?? null,
        createdBy: userId,
      })
      .returning();
    const dto = toPropertyDto(row!);
    await recordAudit(tx, identity, {
      action: 'property.created',
      entityType: 'property',
      entityId: dto.id,
      organizationId,
      after: {
        name: dto.name,
        kind: dto.kind,
        marketId: dto.marketId,
        titleStatus: dto.titleStatus,
      },
      correlationId: options.correlationId,
    });
    return dto;
  });
}

export async function getProperty(identity: RequestIdentity, id: string): Promise<PropertyDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await requireProperty(tx, identity, id, 'read');
    return toPropertyDto(row);
  });
}

export async function updateProperty(
  identity: RequestIdentity,
  id: string,
  input: PropertyUpdate,
  options: ServiceOptions = {},
): Promise<PropertyDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const current = await requireProperty(tx, identity, id, 'manage');
    if (current.status === 'archived') {
      throw new ApiError('invalid_transition', 'archived properties cannot be edited');
    }
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    await assertReferences(tx, current.organizationId, input);
    const patch: Partial<PropertyInsert> = { version: current.version + 1 };
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.address !== undefined) patch.address = input.address;
    if (input.marketId !== undefined) patch.marketId = input.marketId;
    if (input.neighborhoodId !== undefined) patch.neighborhoodId = input.neighborhoodId;
    if (input.estateId !== undefined) patch.estateId = input.estateId;
    if (input.location !== undefined) patch.location = input.location;
    if (input.preciseLocationPublic !== undefined)
      patch.preciseLocationPublic = input.preciseLocationPublic;
    if (input.landArea !== undefined) Object.assign(patch, areaColumns(input.landArea));
    if (input.floorAreaM2 !== undefined) patch.floorAreaM2 = input.floorAreaM2;
    if (input.titleType !== undefined) patch.titleType = input.titleType;
    if (input.titleStatus !== undefined) patch.titleStatus = input.titleStatus;
    if (input.titleNote !== undefined) patch.titleNote = input.titleNote;
    const updated = await tx
      .update(schema.properties)
      .set(patch)
      .where(and(eq(schema.properties.id, id), eq(schema.properties.version, current.version)))
      .returning();
    const row = updated[0];
    if (!row) throw versionConflict();
    const { version: _v, ...changes } = patch;
    await recordAudit(tx, identity, {
      action: 'property.updated',
      entityType: 'property',
      entityId: id,
      organizationId: current.organizationId,
      before: pickBefore(current, changes),
      after: { ...changes, version: row.version },
      correlationId: options.correlationId,
    });
    return toPropertyDto(row);
  });
}

function pickBefore(
  current: typeof schema.properties.$inferSelect,
  changes: Partial<PropertyInsert>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { version: current.version };
  for (const key of Object.keys(changes) as Array<keyof PropertyInsert>) {
    out[key] = current[key as keyof typeof current] ?? null;
  }
  return out;
}

export async function archiveProperty(
  identity: RequestIdentity,
  id: string,
  input: PropertyArchive,
  options: ServiceOptions = {},
): Promise<PropertyDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const current = await requireProperty(tx, identity, id, 'manage');
    if (current.status === 'archived') {
      throw new ApiError('invalid_transition', 'property is already archived');
    }
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const updated = await tx
      .update(schema.properties)
      .set({ status: 'archived', archivedAt: new Date(), version: current.version + 1 })
      .where(and(eq(schema.properties.id, id), eq(schema.properties.version, current.version)))
      .returning();
    const row = updated[0];
    if (!row) throw versionConflict();
    await recordAudit(tx, identity, {
      action: 'property.archived',
      entityType: 'property',
      entityId: id,
      organizationId: current.organizationId,
      before: { status: current.status, version: current.version },
      after: { status: 'archived', version: row.version },
      reason: input.reason ?? null,
      correlationId: options.correlationId,
    });
    return toPropertyDto(row);
  });
}

/**
 * Lists properties the caller may see. Customers are scoped to their active
 * organisation in SQL; staff may scope to one organisation or see all (row
 * level security still applies to both).
 */
export async function listProperties(
  identity: RequestIdentity,
  query: PropertyListQuery,
): Promise<Page<PropertyDto>> {
  requireUserId(identity);
  const staff = isStaffIdentity(identity);
  let organizationId: string | null;
  if (staff) {
    organizationId = query.organizationId ?? identity.ctx.organizationId ?? null;
    assertPropertyRead(identity, propertyRef(organizationId ?? ''));
  } else {
    organizationId = identity.ctx.organizationId;
    if (!organizationId) return { items: [], nextCursor: null };
    if (query.organizationId && query.organizationId !== organizationId) {
      return { items: [], nextCursor: null };
    }
    assertPropertyRead(identity, propertyRef(organizationId));
  }
  const cursor = decodeCursor(query.cursor);
  const term = query.q ? `%${escapeLike(query.q)}%` : null;
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select()
      .from(schema.properties)
      .where(
        and(
          organizationId ? eq(schema.properties.organizationId, organizationId) : undefined,
          query.status === 'archived'
            ? eq(schema.properties.status, 'archived')
            : eq(schema.properties.status, 'active'),
          query.kind ? eq(schema.properties.kind, query.kind) : undefined,
          query.marketId ? eq(schema.properties.marketId, query.marketId) : undefined,
          term
            ? or(
                ilike(schema.properties.name, term),
                sql`${schema.properties.address}->>'city' ILIKE ${term}`,
              )
            : undefined,
          cursor
            ? or(
                lt(schema.properties.createdAt, cursor.createdAt),
                and(
                  eq(schema.properties.createdAt, cursor.createdAt),
                  lt(schema.properties.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.properties.createdAt), desc(schema.properties.id))
      .limit(query.limit + 1),
  );
  const items = rows.slice(0, query.limit).map(toPropertyDto);
  const last = rows.length > query.limit ? rows[query.limit - 1] : null;
  return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Read model for the property detail page. */
export async function getPropertyOverview(
  identity: RequestIdentity,
  id: string,
): Promise<PropertyOverview> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await loadProperty(tx, id);
    if (!row) throw new ApiError('not_found', 'property not found');
    assertPropertyRead(identity, propertyRef(row.organizationId, row.id));

    const unitRows = await tx
      .select({ status: schema.units.status, n: count() })
      .from(schema.units)
      .where(eq(schema.units.propertyId, id))
      .groupBy(schema.units.status);
    const byStatus = { vacant: 0, occupied: 0, unavailable: 0 };
    for (const u of unitRows) byStatus[u.status] = Number(u.n);
    const total = byStatus.vacant + byStatus.occupied + byStatus.unavailable;

    const [parcels] = await tx
      .select({ n: count() })
      .from(schema.parcels)
      .where(eq(schema.parcels.propertyId, id));

    const [authority] = await tx
      .select()
      .from(schema.ownerAuthorities)
      .where(eq(schema.ownerAuthorities.propertyId, id))
      .orderBy(desc(schema.ownerAuthorities.createdAt), desc(schema.ownerAuthorities.id))
      .limit(1);

    const [projects] = await tx
      .select({ n: count() })
      .from(schema.projects)
      .where(and(eq(schema.projects.propertyId, id), isNull(schema.projects.archivedAt)));

    const docs = await tx
      .select({ status: schema.fileObjects.status, n: count() })
      .from(schema.fileObjects)
      .where(
        and(
          eq(schema.fileObjects.entityType, 'property'),
          eq(schema.fileObjects.entityId, id),
          isNull(schema.fileObjects.deletedAt),
          inArray(schema.fileObjects.status, ['clean', 'uploaded', 'scanning']),
        ),
      )
      .groupBy(schema.fileObjects.status);
    let available = 0;
    let pending = 0;
    for (const d of docs) {
      if (d.status === 'clean') available += Number(d.n);
      else pending += Number(d.n);
    }

    return {
      property: toPropertyDto(row),
      units: {
        total,
        occupied: byStatus.occupied,
        vacant: byStatus.vacant,
        unavailable: byStatus.unavailable,
        occupancyPercent: total > 0 ? Math.round((byStatus.occupied / total) * 1000) / 10 : null,
      },
      parcelsCount: Number(parcels?.n ?? 0),
      ownerAuthority: authority
        ? {
            id: authority.id,
            status: authority.status,
            effectiveStatus: effectiveAuthorityStatus(authority.status, authority.expiresAt),
            expiresAt: authority.expiresAt?.toISOString() ?? null,
            verifiedAt: authority.verifiedAt?.toISOString() ?? null,
          }
        : null,
      linkedProjectsCount: Number(projects?.n ?? 0),
      documents: { available, pending },
    };
  });
}

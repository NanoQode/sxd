import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, ilike, inArray, isNull, or, sql, max } from 'drizzle-orm';
import {
  ApiError,
  SENSITIVE_FILE_PURPOSES,
  type ListingContent,
  type ListingCreate,
  type ListingDetailDto,
  type ListingListQuery,
  type ListingMediaFileDto,
  type ListingReason,
  type ListingSummaryDto,
  type ListingUpdate,
  type ListingVersionOnly,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor, type Transaction } from '@simplexd/db';
import { assertAllowed, authorizeOrg } from '@simplexd/domain/authz';
import { evaluateTransition, listingMachine, type ListingState } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  actorContext,
  demote,
  elevate,
  requireUserId,
  type ServiceOptions,
} from '@/server/assignments/shared';
import { effectiveAuthorityStatus } from '@/server/properties/dto';
import {
  assertListingAccess,
  assertListingVersion,
  canStaffReadListings,
  listingRef,
  loadListing,
  loadRevision,
  requireListing,
  requireRevision,
  type ListingRow,
  type RevisionRow,
} from './access';
import { toListingSummaryDto, toRevisionDto } from './dto';
import { invalidatePublicListings } from './public';
import {
  availabilityExpiry,
  effectiveListingStatus,
  listingSlugBase,
  readScope,
} from './rules';

/**
 * Owner side of listings: create (revision 1), revise (each save is a new
 * immutable revision, optimistic concurrency on `listings.version`), submit
 * for moderation (needs a verified, unexpired owner authority for the
 * property), withdraw and re-confirm availability. Staff verification checks
 * live on the revisions and are carried forward to every new revision; the
 * owner can never write them.
 */

const EDITABLE: ListingState[] = ['draft', 'rejected', 'in_moderation', 'published', 'expired'];

function newSlug(title: string): string {
  const suffix = BigInt(`0x${randomBytes(6).toString('hex')}`)
    .toString(36)
    .padStart(8, '0')
    .slice(0, 8);
  return `${listingSlugBase(title)}-${suffix}`;
}

function assertMachine(from: ListingState, to: ListingState, actor: 'customer' | 'staff' | 'system', reason?: string | null) {
  const result = evaluateTransition(listingMachine, { from, to, actor, reason });
  if (!result.ok) {
    throw new ApiError('invalid_transition', result.message, {
      details: { from, to, code: result.code },
    });
  }
}

export function actorKindOf(identity: RequestIdentity): 'customer' | 'staff' {
  return identity.actor.staffRoles.length > 0 ? 'staff' : 'customer';
}

/* ---------------------------------------------------------------------- */
/* Validation shared by create and revise                                  */
/* ---------------------------------------------------------------------- */

/** Listing media must be clean images of the owning organisation. */
export async function assertListingMedia(
  tx: DbExecutor,
  fileIds: string[],
  organizationId: string,
): Promise<void> {
  if (fileIds.length === 0) return;
  if (new Set(fileIds).size !== fileIds.length) {
    throw new ApiError('validation_failed', 'each photo can be attached once', {
      details: [{ path: 'mediaFileIds', message: 'duplicate file' }],
    });
  }
  const rows = await tx
    .select()
    .from(schema.fileObjects)
    .where(inArray(schema.fileObjects.id, fileIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  fileIds.forEach((id, i) => {
    const file = byId.get(id);
    const path = `mediaFileIds.${i}`;
    if (!file || file.organizationId !== organizationId) {
      throw new ApiError('validation_failed', 'media must be files of the listing organisation', {
        details: [{ path, message: 'unknown file for this organisation' }],
      });
    }
    if (file.status === 'infected' || file.status === 'scan_failed') {
      throw new ApiError('file_quarantined', `${file.originalName} is quarantined`);
    }
    if (file.deletedAt || file.status === 'rejected' || file.status === 'deleted') {
      throw new ApiError('file_rejected', `${file.originalName} was rejected or deleted`);
    }
    if (file.status !== 'clean') {
      throw new ApiError('validation_failed', `${file.originalName} has not passed the malware scan yet`, {
        details: [{ path, message: 'not yet scanned; retry when the scan completes' }],
        retryable: true,
      });
    }
    if ((SENSITIVE_FILE_PURPOSES as readonly string[]).includes(file.purpose)) {
      throw new ApiError('validation_failed', 'identity documents can never be listing media', {
        details: [{ path, message: 'sensitive document' }],
      });
    }
    const mime = file.detectedMime ?? file.declaredMime;
    if (!mime.startsWith('image/')) {
      throw new ApiError('validation_failed', 'listing media must be images', {
        details: [{ path, message: `${mime} is not an image` }],
      });
    }
  });
}

/** The requested public precision must be something the property record can support. */
function assertPrecisionSupported(
  property: typeof schema.properties.$inferSelect,
  precision: ListingContent['publicLocationPrecision'],
): void {
  const fail = (message: string) => {
    throw new ApiError('validation_failed', message, {
      details: [{ path: 'publicLocationPrecision', message }],
    });
  };
  if (precision === 'neighborhood' && !property.neighborhoodId)
    fail('the property has no neighbourhood recorded; choose market or state precision');
  if (precision === 'exact' && !property.location)
    fail('the property has no coordinates recorded; add them to the property first');
}

function revisionValues(
  listingId: string,
  version: number,
  content: ListingContent,
  scope: unknown,
  userId: string,
): typeof schema.listingRevisions.$inferInsert {
  return {
    listingId,
    version,
    title: content.title,
    descriptionMarkdown: content.descriptionMarkdown ?? null,
    priceKobo: content.priceKobo ? BigInt(content.priceKobo) : null,
    priceBasis: content.priceKobo ? (content.priceBasis ?? null) : null,
    currency: 'NGN',
    areaM2: content.areaM2 ?? null,
    tenure: content.tenure ?? null,
    titleDisclosure: content.titleDisclosure ?? null,
    availability: content.availability,
    // Staff-owned: carried forward from the previous revision, never taken from the owner.
    verificationScope: (scope ?? { checks: [] }) as typeof schema.listingRevisions.$inferInsert['verificationScope'],
    mediaFileIds: content.mediaFileIds,
    publicLocationPrecision: content.publicLocationPrecision,
    createdBy: userId,
  };
}

/** The newest verified authority that has not lapsed, for the listing's property. */
export async function currentVerifiedAuthority(
  tx: DbExecutor,
  propertyId: string,
  now: Date = new Date(),
) {
  const [row] = await tx
    .select()
    .from(schema.ownerAuthorities)
    .where(
      and(
        eq(schema.ownerAuthorities.propertyId, propertyId),
        eq(schema.ownerAuthorities.status, 'verified'),
        or(isNull(schema.ownerAuthorities.expiresAt), gt(schema.ownerAuthorities.expiresAt, now)),
      ),
    )
    .orderBy(desc(schema.ownerAuthorities.verifiedAt))
    .limit(1);
  return row ?? null;
}

export function authorityRequiredError(): ApiError {
  return new ApiError(
    'insufficient_evidence',
    'a verified, unexpired owner authority for this property is required before moderation',
    { details: { code: 'owner_authority_required' } },
  );
}

/* ---------------------------------------------------------------------- */
/* Read models                                                             */
/* ---------------------------------------------------------------------- */

async function inquiryStats(
  tx: Transaction,
  identity: RequestIdentity,
  listingId: string,
): Promise<{ total: number; lastAt: string | null }> {
  // Leads are staff-only rows; the owner sees a count and nothing else. The
  // caller's access to the listing was proven before this narrowly elevated read.
  const isStaff = identity.actor.staffRoles.length > 0;
  if (!isStaff) await elevate(tx, identity.ctx);
  try {
    const [row] = await tx
      .select({ total: count(), lastAt: max(schema.leads.createdAt) })
      .from(schema.leads)
      .where(
        and(
          sql`${schema.leads.context}->>'listingId' = ${listingId}`,
          sql`${schema.leads.status} <> 'spam'`,
        ),
      );
    return { total: Number(row?.total ?? 0), lastAt: row?.lastAt ? new Date(row.lastAt).toISOString() : null };
  } finally {
    if (!isStaff) await demote(tx, identity.ctx);
  }
}

async function mediaInfo(tx: DbExecutor, ids: string[]): Promise<ListingMediaFileDto[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ file: schema.fileObjects, altText: schema.mediaAssets.altText })
    .from(schema.fileObjects)
    .leftJoin(schema.mediaAssets, eq(schema.mediaAssets.fileId, schema.fileObjects.id))
    .where(inArray(schema.fileObjects.id, ids));
  const byId = new Map(rows.map((r) => [r.file.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id,
        originalName: r.file.originalName,
        status: r.file.deletedAt ? 'deleted' : r.file.status,
        mime: r.file.detectedMime ?? r.file.declaredMime,
        isPublicApproved: r.file.isPublicApproved,
        altText: r.altText ?? null,
      },
    ];
  });
}

export async function buildListingDetail(
  tx: Transaction,
  identity: RequestIdentity,
  row: ListingRow,
  now: Date = new Date(),
): Promise<ListingDetailDto> {
  const current = await requireRevision(tx, row.id, row.currentVersion);
  const published =
    row.publishedVersion === null
      ? null
      : row.publishedVersion === row.currentVersion
        ? current
        : await loadRevision(tx, row.id, row.publishedVersion);
  const revisions = await tx
    .select({
      version: schema.listingRevisions.version,
      title: schema.listingRevisions.title,
      createdBy: schema.listingRevisions.createdBy,
      createdAt: schema.listingRevisions.createdAt,
    })
    .from(schema.listingRevisions)
    .where(eq(schema.listingRevisions.listingId, row.id))
    .orderBy(desc(schema.listingRevisions.version));
  const [property] = await tx
    .select({ name: schema.properties.name, kind: schema.properties.kind })
    .from(schema.properties)
    .where(eq(schema.properties.id, row.propertyId));
  const [org] = await tx
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, row.organizationId));
  const [duplicateOf] = row.duplicateOfListingId
    ? await tx
        .select({ slug: schema.listings.slug })
        .from(schema.listings)
        .where(eq(schema.listings.id, row.duplicateOfListingId))
    : [];
  const verified = await currentVerifiedAuthority(tx, row.propertyId, now);
  const [latestAuthority] = verified
    ? [verified]
    : await tx
        .select()
        .from(schema.ownerAuthorities)
        .where(eq(schema.ownerAuthorities.propertyId, row.propertyId))
        .orderBy(desc(schema.ownerAuthorities.createdAt))
        .limit(1);
  const mediaIds = [
    ...new Set([
      ...(current.mediaFileIds ?? []),
      ...((published?.mediaFileIds as string[] | null) ?? []),
    ]),
  ];
  const [offerStats] = await tx
    .select({
      total: count(),
      open: sql<number>`count(*) filter (where ${schema.offers.status} in ('submitted','countered'))`,
    })
    .from(schema.offers)
    .where(eq(schema.offers.listingId, row.id));
  const summary = toListingSummaryDto(
    row,
    {
      title: current.title,
      organizationName: org?.name ?? null,
      propertyName: property?.name ?? null,
      propertyKind: property?.kind ?? null,
    },
    now,
  );
  return {
    ...summary,
    ownerAuthorityId: row.ownerAuthorityId,
    publishedBy: row.publishedBy,
    moderatedBy: row.moderatedBy,
    duplicateOfSlug: duplicateOf?.slug ?? null,
    current: toRevisionDto(current),
    published: published ? toRevisionDto(published) : null,
    revisions: revisions.map((r) => ({
      version: r.version,
      title: r.title,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    })),
    ownerAuthority: latestAuthority
      ? {
          id: latestAuthority.id,
          ownerName: latestAuthority.ownerName,
          status: latestAuthority.status,
          effectiveStatus: effectiveAuthorityStatus(
            latestAuthority.status,
            latestAuthority.expiresAt,
            now,
          ),
          verifiedAt: latestAuthority.verifiedAt?.toISOString() ?? null,
          expiresAt: latestAuthority.expiresAt?.toISOString() ?? null,
        }
      : null,
    media: await mediaInfo(tx, mediaIds),
    inquiries: await inquiryStats(tx, identity, row.id),
    offers: { total: Number(offerStats?.total ?? 0), open: Number(offerStats?.open ?? 0) },
  };
}

export async function getListingDetail(
  identity: RequestIdentity,
  id: string,
): Promise<ListingDetailDto> {
  requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'read');
    return buildListingDetail(tx, identity, row);
  });
}

export async function listListings(
  identity: RequestIdentity,
  query: ListingListQuery,
): Promise<ListingSummaryDto[]> {
  requireUserId(identity);
  const isStaff = identity.actor.staffRoles.length > 0;
  const organizationId = identity.ctx.organizationId;
  if (isStaff) {
    if (!canStaffReadListings(identity)) {
      throw new ApiError('forbidden', 'listing moderation needs content.publish or rentals.manage');
    }
  } else {
    if (!organizationId) {
      throw new ApiError('forbidden', 'create or join an organisation first', {
        details: { code: 'no_organization', next: '/onboarding' },
      });
    }
    assertListingAccess(identity, listingRef(organizationId), 'read');
  }
  const now = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({
        listing: schema.listings,
        title: schema.listingRevisions.title,
        propertyName: schema.properties.name,
        propertyKind: schema.properties.kind,
        organizationName: schema.organization.name,
      })
      .from(schema.listings)
      .innerJoin(
        schema.listingRevisions,
        and(
          eq(schema.listingRevisions.listingId, schema.listings.id),
          eq(schema.listingRevisions.version, sql`${schema.listings.currentVersion}`),
        ),
      )
      .leftJoin(schema.properties, eq(schema.properties.id, schema.listings.propertyId))
      .leftJoin(schema.organization, eq(schema.organization.id, schema.listings.organizationId))
      .where(
        and(
          isStaff ? undefined : eq(schema.listings.organizationId, organizationId!),
          query.queue === 'moderation' ? eq(schema.listings.status, 'in_moderation') : undefined,
          query.status ? eq(schema.listings.status, query.status) : undefined,
          query.propertyId ? eq(schema.listings.propertyId, query.propertyId) : undefined,
          query.q
            ? or(
                ilike(schema.listingRevisions.title, `%${query.q}%`),
                ilike(schema.listings.slug, `%${query.q}%`),
              )
            : undefined,
        ),
      )
      .orderBy(
        query.queue === 'moderation'
          ? schema.listings.updatedAt
          : desc(schema.listings.updatedAt),
      )
      .limit(query.limit);
    return rows.map((r) =>
      toListingSummaryDto(
        r.listing,
        {
          title: r.title,
          organizationName: r.organizationName,
          propertyName: r.propertyName,
          propertyKind: r.propertyKind,
        },
        now,
      ),
    );
  });
}

/* ---------------------------------------------------------------------- */
/* Mutations                                                               */
/* ---------------------------------------------------------------------- */

export async function createListing(
  identity: RequestIdentity,
  input: ListingCreate,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const result = await withActor(getDb(), ctx, async (tx) => {
    const [property] = await tx
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, input.propertyId));
    if (!property) throw new ApiError('not_found', 'property not found');
    assertListingAccess(identity, listingRef(property.organizationId), 'manage');
    if (property.status !== 'active' || property.archivedAt) {
      throw new ApiError('invalid_transition', 'archived properties cannot be listed');
    }
    assertPrecisionSupported(property, input.publicLocationPrecision);
    await assertListingMedia(tx, input.mediaFileIds, property.organizationId);
    const [listing] = await tx
      .insert(schema.listings)
      .values({
        organizationId: property.organizationId,
        propertyId: property.id,
        kind: input.kind,
        status: 'draft',
        slug: newSlug(input.title),
        currentVersion: 1,
        createdBy: userId,
      })
      .returning();
    await tx
      .insert(schema.listingRevisions)
      .values(revisionValues(listing!.id, 1, input, { checks: [] }, userId));
    await recordAudit(tx, identity, {
      action: 'listing.created',
      entityType: 'listing',
      entityId: listing!.id,
      organizationId: property.organizationId,
      after: { propertyId: property.id, kind: input.kind, slug: listing!.slug, version: 1 },
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, listing!);
  });
  return result;
}

export async function reviseListing(
  identity: RequestIdentity,
  id: string,
  input: ListingUpdate,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'manage');
    assertListingVersion(row, input.expectedVersion);
    if (row.duplicateOfListingId) {
      throw new ApiError('invalid_transition', 'this listing was marked as a duplicate and cannot be edited');
    }
    if (!EDITABLE.includes(row.status)) {
      throw new ApiError('invalid_transition', `a ${row.status.replace(/_/g, ' ')} listing cannot be edited`);
    }
    const [property] = await tx
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, row.propertyId));
    if (!property) throw new ApiError('not_found', 'property not found');
    assertPrecisionSupported(property, input.publicLocationPrecision);
    await assertListingMedia(tx, input.mediaFileIds, row.organizationId);
    const previous = await requireRevision(tx, row.id, row.currentVersion);
    const [updated] = await tx
      .update(schema.listings)
      .set({
        currentVersion: sql`${schema.listings.currentVersion} + 1`,
        version: sql`${schema.listings.version} + 1`,
      })
      .where(and(eq(schema.listings.id, id), eq(schema.listings.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new ApiError('version_conflict', 'the listing changed while saving; reload and try again');
    }
    await tx
      .insert(schema.listingRevisions)
      .values(
        revisionValues(row.id, updated.currentVersion, input, previous.verificationScope, userId),
      );
    await recordAudit(tx, identity, {
      action: 'listing.revised',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { version: row.currentVersion, title: previous.title },
      after: { version: updated.currentVersion, title: input.title },
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, updated);
  });
}

/**
 * Sends the current revision to moderation. Allowed from draft or rejected,
 * from an expired listing (re-confirmation), and from a published listing
 * that has newer changes (it stays live on its approved revision meanwhile).
 */
export async function submitListing(
  identity: RequestIdentity,
  id: string,
  input: ListingVersionOnly,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  return withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'manage');
    assertListingVersion(row, input.expectedVersion);
    if (row.duplicateOfListingId) {
      throw new ApiError('invalid_transition', 'this listing was marked as a duplicate and cannot be resubmitted');
    }
    const effective = effectiveListingStatus(row.status, row.expiresAt, now);
    const from: ListingState = effective === 'expired' ? 'expired' : row.status;
    if (
      row.status === 'published' &&
      effective !== 'expired' &&
      !(row.publishedVersion !== null && row.currentVersion > row.publishedVersion)
    ) {
      throw new ApiError(
        'invalid_transition',
        'the published revision is current; save changes first or re-confirm availability',
      );
    }
    assertMachine(from, 'in_moderation', 'customer');
    const authority = await currentVerifiedAuthority(tx, row.propertyId, now);
    if (!authority) throw authorityRequiredError();
    const [updated] = await tx
      .update(schema.listings)
      .set({
        status: 'in_moderation',
        ownerAuthorityId: authority.id,
        version: sql`${schema.listings.version} + 1`,
      })
      .where(and(eq(schema.listings.id, id), eq(schema.listings.version, input.expectedVersion)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the listing changed while submitting');
    const revision = await requireRevision(tx, id, row.currentVersion);
    await recordAudit(tx, identity, {
      action: 'listing.submitted',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: {
        status: 'in_moderation',
        revisionVersion: row.currentVersion,
        ownerAuthorityId: authority.id,
      },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'listing.submitted',
      aggregateType: 'listing',
      aggregateId: id,
      organizationId: row.organizationId,
      actorUserId: userId,
      payload: {
        listingId: id,
        slug: row.slug,
        title: revision.title,
        revisionVersion: row.currentVersion,
        republication: row.publishedVersion !== null,
      },
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, updated);
  });
}

/** Withdraws a live or pending listing, or archives a draft/rejected one. */
export async function withdrawListing(
  identity: RequestIdentity,
  id: string,
  input: ListingReason,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'manage');
    assertListingVersion(row, input.expectedVersion);
    const effective = effectiveListingStatus(row.status, row.expiresAt, now);
    const from: ListingState = effective === 'expired' ? 'expired' : row.status;
    const to: ListingState = from === 'draft' || from === 'rejected' ? 'archived' : 'withdrawn';
    assertMachine(from, to, 'customer', input.reason);
    const [updated] = await tx
      .update(schema.listings)
      .set({ status: to, version: sql`${schema.listings.version} + 1` })
      .where(and(eq(schema.listings.id, id), eq(schema.listings.version, input.expectedVersion)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the listing changed while withdrawing');
    await recordAudit(tx, identity, {
      action: to === 'archived' ? 'listing.archived' : 'listing.withdrawn',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: to },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, updated);
  });
  await invalidatePublicListings();
  return result;
}

/**
 * Re-confirms availability of a live listing: stamps the confirmation and
 * restarts the availability window. An expired listing is re-submitted to
 * moderation instead (see submitListing).
 */
export async function confirmListingAvailability(
  identity: RequestIdentity,
  id: string,
  input: ListingVersionOnly,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'manage');
    assertListingVersion(row, input.expectedVersion);
    const effective = effectiveListingStatus(row.status, row.expiresAt, now);
    const live =
      (row.status === 'published' || row.status === 'in_moderation') &&
      row.publishedVersion !== null &&
      effective !== 'expired' &&
      !(row.expiresAt && row.expiresAt.getTime() <= now.getTime());
    if (!live) {
      throw new ApiError(
        'invalid_transition',
        'only a live listing can be re-confirmed; an expired listing is re-submitted for moderation',
      );
    }
    const authority = await currentVerifiedAuthority(tx, row.propertyId, now);
    if (!authority) throw authorityRequiredError();
    const expiresAt = availabilityExpiry(now);
    const [updated] = await tx
      .update(schema.listings)
      .set({
        availabilityConfirmedAt: now,
        expiresAt,
        version: sql`${schema.listings.version} + 1`,
      })
      .where(and(eq(schema.listings.id, id), eq(schema.listings.version, input.expectedVersion)))
      .returning();
    if (!updated) throw new ApiError('version_conflict', 'the listing changed while confirming');
    await recordAudit(tx, identity, {
      action: 'listing.availability_confirmed',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { expiresAt: row.expiresAt?.toISOString() ?? null },
      after: { expiresAt: expiresAt.toISOString() },
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, updated);
  });
  await invalidatePublicListings();
  return result;
}

/** Properties of the active organisation that can be listed, with their authority state. */
export async function listListableProperties(identity: RequestIdentity): Promise<
  Array<{
    id: string;
    name: string;
    kind: string;
    authority: 'verified' | 'pending' | 'expired' | 'rejected' | 'none';
    hasMarket: boolean;
    hasNeighborhood: boolean;
    hasLocation: boolean;
  }>
> {
  requireUserId(identity);
  const organizationId = identity.ctx.organizationId;
  if (!organizationId) return [];
  const decision = authorizeOrg(identity.actor, 'org.listings.manage', listingRef(organizationId));
  assertAllowed(decision);
  const now = new Date();
  return withActor(getDb(), identity.ctx, async (tx) => {
    const props = await tx
      .select()
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.organizationId, organizationId),
          eq(schema.properties.status, 'active'),
          isNull(schema.properties.archivedAt),
        ),
      )
      .orderBy(schema.properties.name);
    const authorities = props.length
      ? await tx
          .select()
          .from(schema.ownerAuthorities)
          .where(
            inArray(
              schema.ownerAuthorities.propertyId,
              props.map((p) => p.id),
            ),
          )
          .orderBy(desc(schema.ownerAuthorities.createdAt))
      : [];
    return props.map((p) => {
      const mine = authorities.filter((a) => a.propertyId === p.id);
      const states = mine.map((a) => effectiveAuthorityStatus(a.status, a.expiresAt, now));
      const authority = states.includes('verified')
        ? 'verified'
        : ((states[0] as 'pending' | 'expired' | 'rejected' | undefined) ?? 'none');
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        authority,
        hasMarket: Boolean(p.marketId),
        hasNeighborhood: Boolean(p.neighborhoodId),
        hasLocation: Boolean(p.location),
      };
    });
  });
}

/** Clean images of the organisation that can be attached as listing media. */
export async function listListingMediaCandidates(
  identity: RequestIdentity,
  organizationId: string,
): Promise<ListingMediaFileDto[]> {
  requireUserId(identity);
  assertListingAccess(identity, listingRef(organizationId), 'manage');
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({ file: schema.fileObjects, altText: schema.mediaAssets.altText })
      .from(schema.fileObjects)
      .leftJoin(schema.mediaAssets, eq(schema.mediaAssets.fileId, schema.fileObjects.id))
      .where(
        and(
          eq(schema.fileObjects.organizationId, organizationId),
          eq(schema.fileObjects.status, 'clean'),
          isNull(schema.fileObjects.deletedAt),
          sql`coalesce(${schema.fileObjects.detectedMime}, ${schema.fileObjects.declaredMime}) like 'image/%'`,
          sql`${schema.fileObjects.purpose} <> 'identity'`,
        ),
      )
      .orderBy(desc(schema.fileObjects.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.file.id,
      originalName: r.file.originalName,
      status: r.file.status,
      mime: r.file.detectedMime ?? r.file.declaredMime,
      isPublicApproved: r.file.isPublicApproved,
      altText: r.altText ?? null,
    }));
  });
}

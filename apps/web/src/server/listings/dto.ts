import 'server-only';
import {
  listingLocationPrecisionSchema,
  type ListingRevisionDto,
  type ListingSummaryDto,
} from '@simplexd/contracts';
import type { ListingRow, RevisionRow } from './access';
import { effectiveListingStatus, readScope, toCheckDto } from './rules';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function precisionOf(value: string | null | undefined) {
  const parsed = listingLocationPrecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : 'market';
}

export function toRevisionDto(row: RevisionRow): ListingRevisionDto {
  const scope = readScope(row.verificationScope);
  return {
    version: row.version,
    title: row.title,
    descriptionMarkdown: row.descriptionMarkdown,
    priceKobo: row.priceKobo === null ? null : row.priceKobo.toString(),
    priceBasis: row.priceBasis,
    currency: row.currency,
    areaM2: row.areaM2,
    tenure: row.tenure,
    titleDisclosure: row.titleDisclosure,
    availability: row.availability,
    verification: { checks: scope.checks.map(toCheckDto), summary: scope.summary ?? null },
    mediaFileIds: Array.isArray(row.mediaFileIds) ? row.mediaFileIds : [],
    publicLocationPrecision: precisionOf(row.publicLocationPrecision),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toListingSummaryDto(
  row: ListingRow,
  extras: {
    title: string;
    organizationName: string | null;
    propertyName: string | null;
    propertyKind: ListingSummaryDto['propertyKind'];
  },
  now: Date = new Date(),
): ListingSummaryDto {
  return {
    id: row.id,
    slug: row.slug,
    organizationId: row.organizationId,
    organizationName: extras.organizationName,
    propertyId: row.propertyId,
    propertyName: extras.propertyName,
    propertyKind: extras.propertyKind,
    kind: row.kind,
    status: row.status,
    effectiveStatus: effectiveListingStatus(row.status, row.expiresAt, now),
    title: extras.title,
    currentVersion: row.currentVersion,
    publishedVersion: row.publishedVersion,
    hasUnpublishedChanges:
      row.publishedVersion !== null && row.currentVersion > row.publishedVersion,
    duplicateOfListingId: row.duplicateOfListingId,
    publishedAt: iso(row.publishedAt),
    expiresAt: iso(row.expiresAt),
    availabilityConfirmedAt: iso(row.availabilityConfirmedAt),
    moderationNote: row.moderationNote,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

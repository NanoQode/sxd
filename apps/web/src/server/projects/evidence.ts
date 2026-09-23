import 'server-only';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type EvidenceDto,
  type EvidenceLink,
  type EvidenceListQuery,
  type EvidencePublicationUpdate,
  type Page,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type Transaction } from '@simplexd/db';
import { kindForMime } from '@simplexd/domain/evidence';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { PROJECT_READ_CHECKS, isCustomerOf, requireProject, type ProjectAccess } from './access';
import { ctxFor, decodeCursor, iso, notFound, pageSlice, userIdOf, type ServiceOptions } from './shared';

type EvidenceRow = typeof schema.evidence.$inferSelect;
type FileRow = typeof schema.fileObjects.$inferSelect;

const EVIDENCE_LINK_CHECKS = [
  { staff: 'projects.manage' as const },
  { staff: 'site_visits.perform' as const },
  { staff: 'reports.draft' as const },
  { org: 'org.documents.upload' as const },
  { partner: 'partner.evidence.upload' as const },
];

export function toEvidenceDto(e: EvidenceRow, file: Pick<FileRow, 'originalName' | 'declaredMime' | 'sizeBytes' | 'status'> | null): EvidenceDto {
  return {
    id: e.id,
    organizationId: e.organizationId,
    projectId: e.projectId,
    serviceRequestId: e.serviceRequestId,
    siteVisitId: e.siteVisitId,
    reportId: e.reportId,
    defectId: e.defectId,
    fileId: e.fileId,
    kind: e.kind,
    caption: e.caption,
    capturedAt: iso(e.capturedAt),
    captureGps: e.captureGps,
    captureMetadata: e.captureMetadata ?? null,
    uploaderUserId: e.uploaderUserId,
    receivedAt: e.receivedAt.toISOString(),
    checksumSha256: e.checksumSha256,
    publication: e.publication,
    redactedFileId: e.redactedFileId,
    approvedBy: e.approvedBy,
    approvedAt: iso(e.approvedAt),
    offlineClientId: e.offlineClientId,
    createdAt: e.createdAt.toISOString(),
    // Storage keys are never exposed.
    file: file ? { originalName: file.originalName, declaredMime: file.declaredMime, sizeBytes: file.sizeBytes, status: file.status } : null,
  };
}

/** Validates that an uploaded file may be linked as evidence of this project. */
export async function requireLinkableFile(tx: Transaction, access: ProjectAccess, fileId: string, uploaderUserId: string): Promise<FileRow> {
  const [file] = await tx.select().from(schema.fileObjects).where(eq(schema.fileObjects.id, fileId));
  if (!file) throw notFound('file');
  const sameOrg = file.organizationId === access.project.organizationId;
  const ownUnattached = file.organizationId === null && file.ownerUserId === uploaderUserId;
  if (!sameOrg && !ownUnattached) {
    throw new ApiError('forbidden', 'the file does not belong to this organisation');
  }
  switch (file.status) {
    case 'clean':
      break;
    case 'pending_upload':
    case 'uploaded':
    case 'scanning':
      throw new ApiError('file_quarantined', 'the file has not passed malware scanning yet; retry after it is scanned', {
        details: { fileId, status: file.status },
        retryable: true,
      });
    default:
      throw new ApiError('file_rejected', `the file is ${file.status} and cannot be used as evidence`, {
        details: { fileId, status: file.status },
      });
  }
  if (!file.checksumSha256) {
    throw new ApiError('file_quarantined', 'the file has no checksum yet; finalise the upload first', { details: { fileId } });
  }
  return file;
}

export interface LinkEvidenceResult {
  row: EvidenceRow;
  file: FileRow;
  idempotentReplay: boolean;
}

/** Links a file as evidence inside the caller's transaction (used by site-visit sync too). */
export async function linkEvidenceInTx(
  tx: Transaction,
  identity: RequestIdentity,
  access: ProjectAccess,
  input: EvidenceLink,
  options: ServiceOptions,
): Promise<LinkEvidenceResult> {
  const actorId = userIdOf(identity);
  if (input.offlineClientId) {
    const [existing] = await tx.select().from(schema.evidence).where(eq(schema.evidence.offlineClientId, input.offlineClientId));
    if (existing) {
      if (existing.uploaderUserId !== actorId) {
        throw new ApiError('conflict', 'this offline id was already used by another user');
      }
      const [file] = await tx.select().from(schema.fileObjects).where(eq(schema.fileObjects.id, existing.fileId));
      return { row: existing, file: file!, idempotentReplay: true };
    }
  }
  const file = await requireLinkableFile(tx, access, input.fileId, actorId);
  if (input.siteVisitId) {
    const [v] = await tx.select({ projectId: schema.siteVisits.projectId }).from(schema.siteVisits).where(eq(schema.siteVisits.id, input.siteVisitId));
    if (!v || v.projectId !== access.project.id) throw new ApiError('validation_failed', 'siteVisitId does not belong to this project');
  }
  if (input.reportId) {
    const [r] = await tx.select({ projectId: schema.reports.projectId }).from(schema.reports).where(eq(schema.reports.id, input.reportId));
    if (!r || r.projectId !== access.project.id) throw new ApiError('validation_failed', 'reportId does not belong to this project');
  }
  if (input.defectId) {
    const [d] = await tx.select({ projectId: schema.defects.projectId }).from(schema.defects).where(eq(schema.defects.id, input.defectId));
    if (!d || d.projectId !== access.project.id) throw new ApiError('validation_failed', 'defectId does not belong to this project');
  }
  const [row] = await tx
    .insert(schema.evidence)
    .values({
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      siteVisitId: input.siteVisitId ?? null,
      reportId: input.reportId ?? null,
      defectId: input.defectId ?? null,
      fileId: file.id,
      kind: input.kind ?? kindForMime(file.detectedMime ?? file.declaredMime, file.originalName),
      caption: input.caption ?? null,
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
      captureGps: input.captureGps ?? null,
      captureMetadata: input.captureMetadata ?? null,
      uploaderUserId: actorId,
      // receivedAt defaults to the server clock and is never taken from the client.
      checksumSha256: file.checksumSha256!,
      publication: 'restricted',
      offlineClientId: input.offlineClientId ?? null,
    })
    .returning();
  await recordAudit(tx, identity, {
    action: 'evidence.linked',
    entityType: 'evidence',
    entityId: row!.id,
    organizationId: access.project.organizationId,
    after: { projectId: access.project.id, fileId: file.id, kind: row!.kind, siteVisitId: input.siteVisitId ?? null, reportId: input.reportId ?? null, defectId: input.defectId ?? null },
    correlationId: options.correlationId,
  });
  return { row: row!, file, idempotentReplay: false };
}

export async function linkEvidence(
  identity: RequestIdentity,
  projectId: string,
  input: EvidenceLink,
  options: ServiceOptions = {},
): Promise<EvidenceDto & { idempotentReplay: boolean }> {
  userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await requireProject(tx, identity, projectId, EVIDENCE_LINK_CHECKS);
    const result = await linkEvidenceInTx(tx, identity, access, input, options);
    return { ...toEvidenceDto(result.row, result.file), idempotentReplay: result.idempotentReplay };
  });
}

/** Publication decision (`evidence.approve`, never on one's own upload). */
export async function setEvidencePublication(
  identity: RequestIdentity,
  projectId: string,
  evidenceId: string,
  input: EvidencePublicationUpdate,
  options: ServiceOptions = {},
): Promise<EvidenceDto> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const [row] = await tx.select().from(schema.evidence).where(and(eq(schema.evidence.id, evidenceId), eq(schema.evidence.projectId, projectId)));
    if (!row) throw notFound('evidence');
    const access = await requireProject(tx, identity, projectId, [{ staff: 'evidence.approve' }], { createdBy: row.uploaderUserId });
    if (input.redactedFileId) await requireLinkableFile(tx, access, input.redactedFileId, actorId);
    const approving = input.publication !== 'restricted';
    const [updated] = await tx
      .update(schema.evidence)
      .set({
        publication: input.publication,
        redactedFileId: input.publication === 'redacted_public' ? (input.redactedFileId ?? null) : null,
        approvedBy: approving ? actorId : null,
        approvedAt: approving ? new Date() : null,
      })
      .where(eq(schema.evidence.id, evidenceId))
      .returning();
    await recordAudit(tx, identity, {
      action: 'evidence.publication_changed',
      entityType: 'evidence',
      entityId: evidenceId,
      organizationId: access.project.organizationId,
      before: { publication: row.publication },
      after: { publication: input.publication, redactedFileId: updated!.redactedFileId },
      correlationId: options.correlationId,
    });
    await appendOutbox(tx, {
      eventType: 'project.evidence.publication_changed',
      aggregateType: 'evidence',
      aggregateId: evidenceId,
      organizationId: access.project.organizationId,
      actorUserId: actorId,
      payload: { projectId, evidenceId, publication: input.publication, customerContactUserId: access.project.customerContactUserId },
      correlationId: options.correlationId ?? null,
    });
    const [file] = await tx.select().from(schema.fileObjects).where(eq(schema.fileObjects.id, updated!.fileId));
    return toEvidenceDto(updated!, file ?? null);
  });
}

/** Evidence for a project (optionally per visit/report/defect); customers see approved items and their own uploads. */
export async function listEvidence(
  identity: RequestIdentity,
  projectId: string,
  query: EvidenceListQuery,
): Promise<Page<EvidenceDto>> {
  const actorId = userIdOf(identity);
  return withActor(getDb(), ctxFor(identity), async (tx) => {
    const access = await requireProject(tx, identity, projectId, PROJECT_READ_CHECKS);
    const cursor = decodeCursor(query.cursor);
    const customer = isCustomerOf(identity, access);
    const rows = await tx
      .select({ e: schema.evidence, f: schema.fileObjects })
      .from(schema.evidence)
      .leftJoin(schema.fileObjects, eq(schema.fileObjects.id, schema.evidence.fileId))
      .where(
        and(
          eq(schema.evidence.projectId, projectId),
          query.siteVisitId ? eq(schema.evidence.siteVisitId, query.siteVisitId) : undefined,
          query.reportId ? eq(schema.evidence.reportId, query.reportId) : undefined,
          query.defectId ? eq(schema.evidence.defectId, query.defectId) : undefined,
          query.kind ? eq(schema.evidence.kind, query.kind) : undefined,
          query.publication ? eq(schema.evidence.publication, query.publication) : undefined,
          customer
            ? or(inArray(schema.evidence.publication, ['approved', 'redacted_public']), eq(schema.evidence.uploaderUserId, actorId))
            : undefined,
          cursor
            ? or(lt(schema.evidence.createdAt, cursor.createdAt), and(eq(schema.evidence.createdAt, cursor.createdAt), lt(schema.evidence.id, cursor.id)))
            : undefined,
        ),
      )
      .orderBy(desc(schema.evidence.createdAt), desc(schema.evidence.id))
      .limit(query.limit + 1);
    const page = pageSlice(rows.map((r) => ({ ...r, createdAt: r.e.createdAt, id: r.e.id })), query.limit);
    return { items: page.items.map((r) => toEvidenceDto(r.e, r.f)), nextCursor: page.nextCursor };
  });
}

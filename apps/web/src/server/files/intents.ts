import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  FILE_PURPOSE_POLICIES,
  MULTIPART_THRESHOLD_BYTES,
  UPLOAD_INTENT_TTL_SECONDS,
  type FileEntityType,
  type UploadIntentCreate,
  type UploadIntentResponse,
} from '@simplexd/contracts';
import { applyActorContext, getDb, schema, withActor, type ActorContext, type Transaction } from '@simplexd/db';
import {
  assertAllowed,
  authorizeOrg,
  authorizePartner,
  authorizeStaff,
  type Actor,
  type Decision,
  type ResourceRef,
} from '@simplexd/domain/authz';
import { evaluateUpload, extensionOf } from '@simplexd/domain/evidence';
import {
  StorageError,
  buildStorageKey,
  normalizeContentType,
  planMultipartUpload,
} from '@simplexd/integrations/storage';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { freshMemberships } from './access';
import { ctxFor, isStaffIdentity, userIdOf, type ServiceOptions } from './shared';
import { getStorage } from './storage';

/**
 * Upload intents. The server decides the storage key, the bucket (always
 * quarantine for direct uploads), the size ceiling and the allowed types;
 * the client receives a short-lived signed PUT URL or a multipart plan.
 */

/** Pending uploads that are never finalised are purged by `files.purge_expired`. */
const PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface EntityContext {
  organizationId: string | null;
  resourceType: string;
  /** Users assigned to the entity in any live assignment state (staff relationship rules). */
  staffAssigneeIds: string[];
  /** Users with an accepted/active assignment (partner relationship rule). */
  partnerAssigneeIds: string[];
}

/** Resolves the organisation and assignees of the entity a file will attach to (elevated read). */
async function resolveEntity(
  tx: Transaction,
  ctx: ActorContext,
  entityType: FileEntityType,
  entityId: string,
): Promise<EntityContext | null> {
  await applyActorContext(tx, { ...ctx, bypass: true });
  try {
    const assignmentsFor = async (where: ReturnType<typeof eq>) => {
      const rows = await tx
        .select({ assigneeUserId: schema.assignments.assigneeUserId, status: schema.assignments.status })
        .from(schema.assignments)
        .where(and(where, inArray(schema.assignments.status, ['proposed', 'accepted', 'active'])));
      return {
        staff: rows.map((r) => r.assigneeUserId),
        partner: rows.filter((r) => r.status !== 'proposed').map((r) => r.assigneeUserId),
      };
    };
    switch (entityType) {
      case 'project': {
        const [p] = await tx.select().from(schema.projects).where(eq(schema.projects.id, entityId));
        if (!p) return null;
        const a = await assignmentsFor(eq(schema.assignments.projectId, entityId));
        if (p.pmUserId) a.staff.push(p.pmUserId);
        return { organizationId: p.organizationId, resourceType: 'project', staffAssigneeIds: a.staff, partnerAssigneeIds: a.partner };
      }
      case 'site_visit': {
        const [v] = await tx.select().from(schema.siteVisits).where(eq(schema.siteVisits.id, entityId));
        if (!v) return null;
        const a = v.projectId
          ? await assignmentsFor(eq(schema.assignments.projectId, v.projectId))
          : v.serviceRequestId
            ? await assignmentsFor(eq(schema.assignments.serviceRequestId, v.serviceRequestId))
            : { staff: [], partner: [] };
        if (v.inspectorUserId) {
          a.staff.push(v.inspectorUserId);
          a.partner.push(v.inspectorUserId);
        }
        return { organizationId: v.organizationId, resourceType: 'site_visit', staffAssigneeIds: a.staff, partnerAssigneeIds: a.partner };
      }
      case 'service_request': {
        const [r] = await tx
          .select({ organizationId: schema.serviceRequests.organizationId })
          .from(schema.serviceRequests)
          .where(eq(schema.serviceRequests.id, entityId));
        if (!r) return null;
        const a = await assignmentsFor(eq(schema.assignments.serviceRequestId, entityId));
        return { organizationId: r.organizationId, resourceType: 'service_request', staffAssigneeIds: a.staff, partnerAssigneeIds: a.partner };
      }
      case 'invoice': {
        const [i] = await tx
          .select({ organizationId: schema.invoices.organizationId })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, entityId));
        return i ? { organizationId: i.organizationId, resourceType: 'invoice', staffAssigneeIds: [], partnerAssigneeIds: [] } : null;
      }
      case 'property': {
        const [p] = await tx
          .select({ organizationId: schema.properties.organizationId })
          .from(schema.properties)
          .where(eq(schema.properties.id, entityId));
        return p ? { organizationId: p.organizationId, resourceType: 'property', staffAssigneeIds: [], partnerAssigneeIds: [] } : null;
      }
      case 'content_page': {
        const [c] = await tx.select({ id: schema.contentPages.id }).from(schema.contentPages).where(eq(schema.contentPages.id, entityId));
        return c ? { organizationId: null, resourceType: 'content_page', staffAssigneeIds: [], partnerAssigneeIds: [] } : null;
      }
      default:
        return null;
    }
  } finally {
    await applyActorContext(tx, { ...ctx, bypass: false });
  }
}

function withFreshMemberships(identity: RequestIdentity, memberships: Actor['memberships'], organizationId: string | null): Actor {
  return { ...identity.actor, memberships, activeOrganizationId: organizationId };
}

/**
 * Decides who may create an upload for a purpose. Returns the organisation
 * the file will belong to (null for personal and CMS files).
 */
async function authorizeIntent(
  tx: Transaction,
  identity: RequestIdentity,
  ctx: ActorContext,
  input: UploadIntentCreate,
): Promise<{ organizationId: string | null }> {
  const userId = userIdOf(identity);
  const policy = FILE_PURPOSE_POLICIES[input.purpose];
  if (policy.requiresEntity && !input.entityType) {
    throw new ApiError('validation_failed', `${input.purpose} uploads must name the entity they belong to`, {
      details: [{ path: 'entityType', message: 'required for this purpose' }],
    });
  }
  const entity = input.entityType && input.entityId ? await resolveEntity(tx, ctx, input.entityType, input.entityId) : null;
  if (input.entityType && !entity) throw new ApiError('not_found', `${input.entityType} not found`);
  const memberships = await freshMemberships(tx, userId);
  const orgOf = (fallback: string | null) => entity?.organizationId ?? fallback;

  const orgCheck = (permission: 'org.documents.upload' | 'org.invoices.pay', organizationId: string | null): Decision => {
    if (!organizationId) return { allowed: false, code: 'no_permission', reason: 'no active organisation' };
    return authorizeOrg(withFreshMemberships(identity, memberships, organizationId), permission, {
      type: entity?.resourceType ?? 'organization',
      id: input.entityId,
      organizationId,
    });
  };

  switch (input.purpose) {
    case 'org_document': {
      const organizationId = orgOf(identity.actor.activeOrganizationId);
      if (isStaffIdentity(identity) && entity) {
        const decision = authorizeStaff(identity.actor, 'projects.manage', {
          type: entity.resourceType,
          id: input.entityId,
          organizationId: entity.organizationId,
          assigneeUserIds: entity.staffAssigneeIds,
        });
        if (decision.allowed) return { organizationId };
      }
      assertAllowed(orgCheck('org.documents.upload', organizationId));
      return { organizationId };
    }
    case 'evidence': {
      const e = entity!;
      const ref: ResourceRef = {
        type: e.resourceType,
        id: input.entityId,
        organizationId: e.organizationId,
        assigneeUserIds: e.staffAssigneeIds,
      };
      let last: Decision = { allowed: false, code: 'no_permission', reason: 'not allowed to upload evidence here' };
      if (isStaffIdentity(identity)) {
        for (const permission of ['site_visits.perform', 'projects.manage'] as const) {
          last = authorizeStaff(identity.actor, permission, ref);
          if (last.allowed) return { organizationId: e.organizationId };
        }
      }
      if (identity.actor.isPartner) {
        last = authorizePartner(identity.actor, 'partner.evidence.upload', {
          ...ref,
          assigneeUserIds: e.partnerAssigneeIds,
        });
        if (last.allowed) return { organizationId: e.organizationId };
      }
      if (e.organizationId && memberships.some((m) => m.organizationId === e.organizationId)) {
        last = orgCheck('org.documents.upload', e.organizationId);
        if (last.allowed) return { organizationId: e.organizationId };
      }
      assertAllowed(last);
      return { organizationId: e.organizationId };
    }
    case 'content_media': {
      assertAllowed(authorizeStaff(identity.actor, 'content.media.manage', { type: 'content_page', id: input.entityId }));
      return { organizationId: null };
    }
    case 'bank_receipt': {
      const organizationId = orgOf(identity.actor.activeOrganizationId);
      assertAllowed(orgCheck('org.invoices.pay', organizationId));
      return { organizationId };
    }
    case 'identity': {
      // Personal document: owned by the user, never shared with an organisation.
      if (input.entityType) throw new ApiError('validation_failed', 'identity documents are not attached to entities');
      return { organizationId: null };
    }
    default:
      throw new ApiError('validation_failed', 'unknown purpose');
  }
}

function familyOf(mime: string): 'image' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/** Applies the purpose allow-list, blocked types/extensions and size ceilings. */
export function validateDeclaredUpload(input: UploadIntentCreate): { mime: string } {
  const policy = FILE_PURPOSE_POLICIES[input.purpose];
  const mime = normalizeContentType(input.declaredMime);
  const familyMax = policy.maxBytesByFamily[familyOf(mime)];
  const decision = evaluateUpload(
    { fileName: input.fileName, declaredMime: mime, sizeBytes: input.sizeBytes, purpose: input.purpose },
    { allowedMime: policy.allowedMime, maxBytes: Math.min(policy.maxBytes, familyMax > 0 ? familyMax : policy.maxBytes) },
  );
  if (!decision.ok) {
    throw new ApiError('file_rejected', decision.reason, {
      details: { purpose: input.purpose, declaredMime: mime, sizeBytes: input.sizeBytes },
    });
  }
  return { mime };
}

export async function createUploadIntent(
  identity: RequestIdentity,
  input: UploadIntentCreate,
  options: ServiceOptions = {},
): Promise<UploadIntentResponse> {
  const userId = userIdOf(identity);
  const { mime } = validateDeclaredUpload(input);
  const ctx = ctxFor(identity, options);
  const storage = getStorage();
  return withActor(getDb(), ctx, async (tx) => {
    const { organizationId } = await authorizeIntent(tx, identity, ctx, input);
    const fileId = randomUUID();
    let storageKey: string;
    try {
      storageKey = buildStorageKey({ organizationId, purpose: input.purpose, fileId, ext: extensionOf(input.fileName) || null });
    } catch (err) {
      if (err instanceof StorageError)
        throw new ApiError('file_rejected', err.message, { details: { fileName: input.fileName } });
      throw err;
    }
    const multipart = input.multipart === true || input.sizeBytes > MULTIPART_THRESHOLD_BYTES;
    const plan = multipart ? planMultipartUpload(input.sizeBytes) : null;
    await tx.insert(schema.fileObjects).values({
      id: fileId,
      organizationId,
      ownerUserId: userId,
      bucket: 'quarantine',
      storageKey,
      originalName: input.fileName,
      declaredMime: mime,
      sizeBytes: input.sizeBytes,
      // Client-declared checksum is recorded as user-provided metadata until verified.
      checksumSha256: null,
      scanResult: input.sha256 ? { declaredSha256: input.sha256 } : null,
      status: 'pending_upload',
      uploadKind: multipart ? 'multipart' : 'single',
      purpose: input.purpose,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      retentionUntil: new Date(Date.now() + PENDING_RETENTION_MS),
    });
    let intent;
    try {
      intent = await storage.createUploadIntent({
        bucket: 'quarantine',
        key: storageKey,
        contentType: mime,
        sizeBytes: input.sizeBytes,
        multipart,
        partCount: plan?.partCount,
        expiresInSeconds: UPLOAD_INTENT_TTL_SECONDS,
      });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'invalid_request')
        throw new ApiError('validation_failed', err.message);
      throw new ApiError('provider_unavailable', 'the storage provider refused the upload request', { retryable: true });
    }
    if (intent.kind === 'multipart') {
      await tx
        .update(schema.fileObjects)
        .set({ multipartUploadId: intent.uploadId })
        .where(eq(schema.fileObjects.id, fileId));
    }
    await recordAudit(tx, identity, {
      action: 'file.upload_intent_created',
      entityType: 'file',
      entityId: fileId,
      organizationId,
      after: { purpose: input.purpose, declaredMime: mime, sizeBytes: input.sizeBytes, uploadKind: intent.kind },
      correlationId: options.correlationId,
    });
    return {
      fileId,
      status: 'pending_upload',
      expiresAt: intent.expiresAt.toISOString(),
      upload:
        intent.kind === 'single'
          ? { kind: 'single', method: 'PUT', url: intent.url, headers: intent.headers }
          : {
              kind: 'multipart',
              method: 'PUT',
              uploadId: intent.uploadId,
              partSizeBytes: plan!.partSizeBytes,
              parts: intent.partUrls,
            },
    };
  });
}

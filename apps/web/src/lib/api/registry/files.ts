import { z } from 'zod';
import {
  fileDownloadQuerySchema,
  fileDownloadResponseSchema,
  fileDtoSchema,
  fileFinalizeResponseSchema,
  fileFinalizeSchema,
  fileGrantCreateSchema,
  fileGrantDtoSchema,
  fileListQuerySchema,
  filePublicApprovalResponseSchema,
  filePublicApprovalSchema,
  listRoutes,
  pageOf,
  registerRoute,
  uploadIntentCreateSchema,
  uploadIntentResponseSchema,
  uuidSchema,
  type RouteSpec,
} from '@simplexd/contracts';

/** OpenAPI registrations for the private file pipeline (idempotent across hot reloads). */

function ensure(spec: RouteSpec): RouteSpec {
  return listRoutes().find((r) => r.operationId === spec.operationId) ?? registerRoute(spec);
}

const idParams = z.object({ id: uuidSchema });

export const filesRoutes = [
  ensure({
    method: 'post',
    path: '/api/v1/files/upload-intents',
    summary: 'Create an upload intent',
    description:
      'Validates purpose, declared type and size, creates a pending file in quarantine and returns a signed PUT URL (or a multipart plan for large files). Authorisation depends on the purpose: org_document (org.documents.upload), evidence (assigned staff with site_visits.perform, partners with partner.evidence.upload, or the customer organisation), content_media (content.media.manage), bank_receipt (org.invoices.pay), identity (any signed-in user; sensitive). Rate limited per user.',
    tags: ['Files'],
    operationId: 'createUploadIntent',
    auth: 'session',
    request: { body: uploadIntentCreateSchema },
    responses: {
      201: { description: 'Upload intent', body: uploadIntentResponseSchema },
      422: { description: 'Type or size not accepted for this purpose (file_rejected)' },
      429: { description: 'Rate limited' },
    },
  }),
  ensure({
    method: 'post',
    path: '/api/v1/files/{id}/finalize',
    summary: 'Finalise an upload',
    description:
      'Owner only. Completes multipart uploads, verifies size and checksum, sniffs the bytes (declared type vs content, markup/script detection) and hands the file to the malware scanner. Rejected files answer 422 file_rejected.',
    tags: ['Files'],
    operationId: 'finalizeUpload',
    auth: 'session',
    request: { params: idParams, body: fileFinalizeSchema },
    responses: {
      202: { description: 'Scanning queued', body: fileFinalizeResponseSchema },
      409: { description: 'Bytes not uploaded yet, or state changed' },
      422: { description: 'Rejected by content inspection (file_rejected)' },
    },
  }),
  ensure({
    method: 'get',
    path: '/api/v1/files',
    summary: 'List files attached to an entity',
    tags: ['Files'],
    operationId: 'listFiles',
    auth: 'session',
    request: { query: fileListQuerySchema },
    responses: { 200: { description: 'Files the caller may view', body: pageOf(fileDtoSchema) } },
  }),
  ensure({
    method: 'get',
    path: '/api/v1/files/{id}',
    summary: 'File metadata and scan status',
    tags: ['Files'],
    operationId: 'getFile',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'File', body: fileDtoSchema } },
  }),
  ensure({
    method: 'get',
    path: '/api/v1/files/{id}/download',
    summary: 'Redirect to a signed download URL',
    description:
      'Access is re-evaluated on every call (owner, organisation membership with org.documents.view re-read from the database, explicit grant, staff files.read_all; sensitive purposes need files.sensitive.read). Only clean files are served; quarantined files answer 423 file_quarantined and infected/rejected files 422 file_rejected. The URL expires after 5 minutes by default (15 max). Anything not inline-safe is served as an attachment. Every issuance is logged.',
    tags: ['Files'],
    operationId: 'downloadFile',
    auth: 'session',
    request: { params: idParams, query: fileDownloadQuerySchema },
    responses: {
      302: { description: 'Redirect to the signed URL' },
      200: { description: 'Signed URL (Accept: application/json)', body: fileDownloadResponseSchema },
      422: { description: 'Infected or rejected (file_rejected)' },
      423: { description: 'Not scanned yet or scanner failed (file_quarantined)' },
    },
  }),
  ensure({
    method: 'get',
    path: '/api/v1/files/{id}/grants',
    summary: 'List grants on a file',
    tags: ['Files'],
    operationId: 'listFileGrants',
    auth: 'session',
    request: { params: idParams },
    responses: { 200: { description: 'Grants', body: z.object({ items: z.array(fileGrantDtoSchema) }) } },
  }),
  ensure({
    method: 'post',
    path: '/api/v1/files/{id}/grants',
    summary: 'Grant a user or organisation access to a file',
    description: 'Owner or staff with files.read_all. Sensitive documents can only be granted to users.',
    tags: ['Files'],
    operationId: 'createFileGrant',
    auth: 'session',
    request: { params: idParams, body: fileGrantCreateSchema },
    responses: { 201: { description: 'Grant', body: fileGrantDtoSchema } },
  }),
  ensure({
    method: 'delete',
    path: '/api/v1/files/{id}/grants/{grantId}',
    summary: 'Revoke a grant',
    tags: ['Files'],
    operationId: 'revokeFileGrant',
    auth: 'session',
    request: { params: z.object({ id: uuidSchema, grantId: uuidSchema }) },
    responses: { 200: { description: 'Revoked grant', body: fileGrantDtoSchema } },
  }),
  ensure({
    method: 'post',
    path: '/api/v1/files/{id}/public-approval',
    summary: 'Approve or revoke public use of an image’s derivatives',
    description:
      'Staff with evidence.approve or content.media.manage (never on their own uploads). Only clean images with a web derivative can be approved; originals and sensitive documents are never public. Records a media_assets row with alt text and rights confirmation.',
    tags: ['Files'],
    operationId: 'setFilePublicApproval',
    auth: 'staff',
    request: { params: idParams, body: filePublicApprovalSchema },
    responses: { 200: { description: 'Updated file and media asset', body: filePublicApprovalResponseSchema } },
  }),
];

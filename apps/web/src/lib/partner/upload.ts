'use client';

import type {
  FileDto,
  FileEntityType,
  FilePurpose,
  UploadIntentResponse,
  FileFinalizeResponse,
} from '@simplexd/contracts';
import { partnerFetch } from './api';

/**
 * Browser upload pipeline: intent → PUT to the signed URL → finalize. Files
 * above the single-PUT threshold come back as multipart plans, which this
 * client does not implement; callers get a clear error instead.
 */

export async function putBytes(
  url: string,
  headers: Record<string, string>,
  bytes: ArrayBuffer | Blob,
  mime: string,
): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': headers['content-type'] ?? mime },
    body: bytes,
  });
  if (!res.ok) throw new Error(`storage refused the upload (${res.status})`);
}

export async function uploadFile(
  file: File,
  target: { purpose: FilePurpose; entityType?: FileEntityType; entityId?: string },
  onProgress?: (stage: 'intent' | 'upload' | 'finalize') => void,
): Promise<{ file: FileDto; outcome: FileFinalizeResponse['outcome'] }> {
  onProgress?.('intent');
  const intent = await partnerFetch<UploadIntentResponse>('/api/v1/files/upload-intents', {
    body: {
      purpose: target.purpose,
      fileName: file.name,
      declaredMime: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      ...(target.entityType && target.entityId
        ? { entityType: target.entityType, entityId: target.entityId }
        : {}),
    },
  });
  if (intent.upload.kind !== 'single') {
    throw new Error(
      'This file needs a resumable multipart upload, which the partner workspace does not support yet. Keep files under 64 MB.',
    );
  }
  onProgress?.('upload');
  await putBytes(intent.upload.url, intent.upload.headers, file, file.type);
  onProgress?.('finalize');
  const finalized = await partnerFetch<FileFinalizeResponse>(
    `/api/v1/files/${intent.fileId}/finalize`,
    { body: {} },
  );
  return { file: finalized.file, outcome: finalized.outcome };
}

/** Opens a short-lived signed download in a new tab; never caches the bytes. */
export async function openSignedDownload(
  fileId: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<void> {
  const res = await partnerFetch<{ url: string }>(
    `/api/v1/files/${fileId}/download?disposition=${disposition}`,
  );
  window.open(res.url, '_blank', 'noopener,noreferrer');
}

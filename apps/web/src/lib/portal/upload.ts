'use client';

import type {
  FileDto,
  FileEntityType,
  FileFinalizeResponse,
  FilePurpose,
  UploadIntentResponse,
} from '@simplexd/contracts';
import { FILE_PURPOSE_POLICIES } from '@simplexd/contracts';
import { ApiClientError, portalFetch } from './client';

/**
 * Browser upload pipeline: upload intent → PUT the bytes to the signed URL
 * (single request, or one request per part for large files) → finalize.
 * Progress is reported per byte; the server then sniffs and scans the file,
 * so the returned file is `scanning` until the scanner reports.
 */

export type UploadPhase = 'preparing' | 'uploading' | 'finalizing' | 'scanning' | 'done' | 'failed';

export interface UploadProgress {
  phase: UploadPhase;
  /** 0–100 for the byte transfer; null before it starts. */
  percent: number | null;
  bytesSent: number;
  bytesTotal: number;
  partsDone?: number;
  partsTotal?: number;
}

export interface UploadOptions {
  purpose: FilePurpose;
  entityType?: FileEntityType;
  entityId?: string;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface UploadOutcome {
  file: FileDto;
  outcome: FileFinalizeResponse['outcome'];
}

/** Explains why a file cannot be uploaded for the purpose before any network call. */
export function validateForPurpose(file: File, purpose: FilePurpose): string | null {
  const policy = FILE_PURPOSE_POLICIES[purpose];
  const mime = file.type || 'application/octet-stream';
  if (!policy.allowedMime.includes(mime)) {
    return `${file.name}: ${mime || 'unknown type'} is not accepted for this purpose. Accepted: ${describeMimes(policy.allowedMime)}.`;
  }
  const family = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : 'document';
  const cap = Math.min(policy.maxBytes, policy.maxBytesByFamily[family] || policy.maxBytes);
  if (file.size > cap) {
    return `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit for this purpose is ${Math.round(cap / (1024 * 1024))} MB.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

function describeMimes(mimes: readonly string[]): string {
  const labels = new Set<string>();
  for (const m of mimes) {
    if (m.startsWith('image/')) labels.add('images');
    else if (m.startsWith('video/')) labels.add('MP4/MOV video');
    else if (m === 'application/pdf') labels.add('PDF');
    else if (m.includes('wordprocessingml')) labels.add('Word');
    else if (m.includes('spreadsheetml')) labels.add('Excel');
    else if (m === 'text/csv') labels.add('CSV');
    else if (m === 'application/zip') labels.add('ZIP');
  }
  return [...labels].join(', ');
}

async function sha256Hex(file: File): Promise<string | undefined> {
  // Hashing very large files in the browser is slow; the server verifies the
  // declared size and sniffs content regardless, so skip past 256 MB.
  if (file.size > 256 * 1024 * 1024 || typeof crypto === 'undefined' || !crypto.subtle)
    return undefined;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onBytes: (sent: number) => void,
  signal?: AbortSignal,
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onBytes(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onBytes(body.size);
        resolve({ etag: xhr.getResponseHeader('etag') });
      } else {
        reject(new Error(`storage answered ${xhr.status} while receiving the file`));
      }
    };
    xhr.onerror = () =>
      reject(new Error('the upload connection failed; check your network and try again'));
    xhr.onabort = () => reject(new DOMException('upload cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

export async function uploadFile(file: File, options: UploadOptions): Promise<UploadOutcome> {
  const report = (p: UploadProgress) => options.onProgress?.(p);
  report({ phase: 'preparing', percent: null, bytesSent: 0, bytesTotal: file.size });
  const sha256 = await sha256Hex(file);
  const intent = await portalFetch<UploadIntentResponse>('/api/v1/files/upload-intents', {
    body: {
      purpose: options.purpose,
      fileName: file.name,
      declaredMime: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      ...(sha256 ? { sha256 } : {}),
      ...(options.entityType && options.entityId
        ? { entityType: options.entityType, entityId: options.entityId }
        : {}),
    },
    signal: options.signal,
  });

  let parts: Array<{ partNumber: number; etag: string }> | undefined;
  if (intent.upload.kind === 'single') {
    report({ phase: 'uploading', percent: 0, bytesSent: 0, bytesTotal: file.size });
    await putWithProgress(
      intent.upload.url,
      file,
      intent.upload.headers,
      (sent) =>
        report({
          phase: 'uploading',
          percent: Math.round((sent / file.size) * 100),
          bytesSent: sent,
          bytesTotal: file.size,
        }),
      options.signal,
    );
  } else {
    const { partSizeBytes, parts: plan } = intent.upload;
    parts = [];
    let sentBefore = 0;
    for (let i = 0; i < plan.length; i += 1) {
      const part = plan[i]!;
      const start = (part.partNumber - 1) * partSizeBytes;
      const chunk = file.slice(start, Math.min(start + partSizeBytes, file.size));
      const base = sentBefore;
      const result = await putWithProgress(
        part.url,
        chunk,
        { 'content-type': 'application/octet-stream' },
        (sent) =>
          report({
            phase: 'uploading',
            percent: Math.round(((base + sent) / file.size) * 100),
            bytesSent: base + sent,
            bytesTotal: file.size,
            partsDone: i,
            partsTotal: plan.length,
          }),
        options.signal,
      );
      if (!result.etag) throw new Error(`storage returned no ETag for part ${part.partNumber}`);
      parts.push({ partNumber: part.partNumber, etag: result.etag.replace(/^"|"$/g, '') });
      sentBefore += chunk.size;
    }
  }

  report({ phase: 'finalizing', percent: 100, bytesSent: file.size, bytesTotal: file.size });
  try {
    const finalized = await portalFetch<FileFinalizeResponse>(
      `/api/v1/files/${intent.fileId}/finalize`,
      {
        body: { ...(sha256 ? { sha256 } : {}), ...(parts ? { parts } : {}) },
        signal: options.signal,
      },
    );
    report({ phase: 'scanning', percent: 100, bytesSent: file.size, bytesTotal: file.size });
    return { file: finalized.file, outcome: finalized.outcome };
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'file_rejected') {
      const file = await portalFetch<FileDto>(`/api/v1/files/${intent.fileId}`).catch(() => null);
      if (file) return { file, outcome: 'rejected' };
    }
    throw err;
  }
}

export const SETTLED_FILE_STATUSES = new Set([
  'clean',
  'infected',
  'scan_failed',
  'rejected',
  'deleted',
]);

/** Polls until the scanner reports; resolves with the final file record. */
export async function waitForScan(
  fileId: string,
  options: { intervalMs?: number; maxWaitMs?: number; signal?: AbortSignal } = {},
): Promise<FileDto> {
  const interval = options.intervalMs ?? 1500;
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000);
  let last: FileDto | null = null;
  while (Date.now() < deadline) {
    last = await portalFetch<FileDto>(`/api/v1/files/${fileId}`, { signal: options.signal });
    if (SETTLED_FILE_STATUSES.has(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (last) return last;
  throw new Error(
    'the scan is taking longer than expected; the file will appear once it is cleared',
  );
}

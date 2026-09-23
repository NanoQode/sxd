'use client';

import type { FileDto } from '@simplexd/contracts';
import { partnerFetch } from './api';

/**
 * Uploaded files are scanned by the worker before anything may reference
 * them. Polls `GET /api/v1/files/{id}` until the scan settles; resolves with
 * the final status (`clean`, or a refusal), or `scanning` when the deadline
 * passes so the caller can say "still scanning" instead of guessing.
 */
export async function waitForScan(
  fileId: string,
  options: { attempts?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: FileDto['status']; reason: string | null }> {
  const attempts = options.attempts ?? 20;
  const interval = options.intervalMs ?? 3000;
  let last: FileDto | null = null;
  for (let i = 0; i < attempts; i += 1) {
    if (options.signal?.aborted) break;
    last = await partnerFetch<FileDto>(`/api/v1/files/${fileId}`, { signal: options.signal });
    if (
      last.status !== 'scanning' &&
      last.status !== 'uploaded' &&
      last.status !== 'pending_upload'
    ) {
      return { status: last.status, reason: last.statusReason };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { status: 'scanning', reason: last?.statusReason ?? null };
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StatusBadge } from '@simplexd/ui';
import { portalFetch } from '@/lib/portal/client';
import { SETTLED_FILE_STATUSES } from '@/lib/portal/upload';

const LABELS: Record<string, string> = {
  pending_upload: 'Upload incomplete',
  uploaded: 'Queued for scanning',
  scanning: 'Scanning',
  clean: 'Scanned clean',
  infected: 'Blocked: malware',
  scan_failed: 'Scan failed',
  rejected: 'Rejected',
  deleted: 'Deleted',
};

const TONE_STATUS: Record<string, string> = {
  pending_upload: 'pending',
  uploaded: 'pending',
  scanning: 'pending',
  clean: 'successful',
  infected: 'failed',
  scan_failed: 'uncertain',
  rejected: 'failed',
  deleted: 'cancelled',
};

/**
 * Scan status pill. While a file is still in quarantine it polls the API and
 * refreshes the page data once the scanner settles, so lists never show a
 * stale "scanning" state that a reload would contradict.
 */
export function FileStatusBadge({
  fileId,
  status: initial,
  reason,
  poll = true,
}: {
  fileId: string;
  status: string;
  reason?: string | null;
  poll?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [statusReason, setStatusReason] = useState(reason ?? null);
  useEffect(() => {
    if (!poll || SETTLED_FILE_STATUSES.has(status)) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const file = await portalFetch<{ status: string; statusReason: string | null }>(
          `/api/v1/files/${fileId}`,
        );
        if (cancelled) return;
        if (file.status !== status) {
          setStatus(file.status);
          setStatusReason(file.statusReason);
          if (SETTLED_FILE_STATUSES.has(file.status)) router.refresh();
        }
      } catch {
        // Transient; the next tick retries. Stop after the interval unmounts.
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fileId, status, poll, router]);
  return (
    <span className="inline-flex flex-col gap-0.5">
      <StatusBadge
        status={TONE_STATUS[status] ?? status}
        label={LABELS[status] ?? status.replace(/_/g, ' ')}
      />
      {statusReason && status !== 'clean' ? (
        <span className="text-xs text-fg-muted">{statusReason}</span>
      ) : null}
    </span>
  );
}

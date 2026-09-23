'use client';

import { Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import type { FileDto, FileEntityType, FilePurpose } from '@simplexd/contracts';
import { Alert, Button, cn } from '@simplexd/ui';
import { describeError } from '@/lib/portal/client';
import { formatBytes } from '@/lib/portal/format';
import {
  uploadFile,
  validateForPurpose,
  waitForScan,
  type UploadProgress,
} from '@/lib/portal/upload';

interface Item {
  key: string;
  name: string;
  size: number;
  progress: UploadProgress;
  file: FileDto | null;
  error: { message: string; correlationId: string | null } | null;
  controller: AbortController;
}

/**
 * Upload control with per-file progress, resumable multipart for large files
 * (planned by the server), and the honest scanning → clean/rejected states.
 * Calls `onUploaded` with the scanned file so callers can attach it.
 */
export function FileUploader({
  purpose,
  entityType,
  entityId,
  multiple = true,
  accept,
  label = 'Upload files',
  hint,
  onUploaded,
  refreshOnSettle = true,
  compact = false,
  disabled,
  disabledReason,
}: {
  purpose: FilePurpose;
  entityType?: FileEntityType;
  entityId?: string;
  multiple?: boolean;
  accept?: string;
  label?: string;
  hint?: string;
  onUploaded?: (file: FileDto) => void;
  refreshOnSettle?: boolean;
  compact?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [precheck, setPrecheck] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  async function start(files: FileList | File[]) {
    const list = Array.from(files);
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const f of list) {
      const problem = validateForPurpose(f, purpose);
      if (problem) problems.push(problem);
      else accepted.push(f);
    }
    setPrecheck(problems);
    for (const file of accepted) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      const item: Item = {
        key,
        name: file.name,
        size: file.size,
        progress: { phase: 'preparing', percent: null, bytesSent: 0, bytesTotal: file.size },
        file: null,
        error: null,
        controller,
      };
      setItems((prev) => [item, ...prev]);
      void (async () => {
        try {
          const result = await uploadFile(file, {
            purpose,
            entityType,
            entityId,
            signal: controller.signal,
            onProgress: (progress) => update(key, { progress }),
          });
          if (result.outcome === 'rejected') {
            update(key, {
              file: result.file,
              progress: { ...item.progress, phase: 'failed', percent: 100 },
              error: {
                message: result.file.statusReason ?? 'The file was rejected by content inspection.',
                correlationId: null,
              },
            });
            return;
          }
          update(key, {
            file: result.file,
            progress: { ...item.progress, phase: 'scanning', percent: 100, bytesSent: file.size },
          });
          const settled = await waitForScan(result.file.id, { signal: controller.signal }).catch(
            () => result.file,
          );
          update(key, {
            file: settled,
            progress: {
              ...item.progress,
              phase:
                settled.status === 'clean'
                  ? 'done'
                  : settled.status === 'scanning'
                    ? 'scanning'
                    : 'failed',
              percent: 100,
              bytesSent: file.size,
            },
            error:
              settled.status === 'clean' || settled.status === 'scanning'
                ? null
                : {
                    message:
                      settled.statusReason ?? `Scan outcome: ${settled.status.replace(/_/g, ' ')}.`,
                    correlationId: null,
                  },
          });
          onUploaded?.(settled);
          if (refreshOnSettle) router.refresh();
        } catch (err) {
          const e = describeError(err);
          update(key, {
            progress: { ...item.progress, phase: 'failed' },
            error: { message: e.message, correlationId: e.correlationId },
          });
        }
      })();
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  if (disabled) {
    return (
      <p
        role="status"
        className="rounded-md border border-dashed border-border bg-bg-sunken p-3 text-sm text-fg-muted"
      >
        {disabledReason ?? 'Uploads are not available here.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) void start(e.dataTransfer.files);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center',
          compact ? 'p-3' : 'p-6',
          dragging ? 'border-primary bg-primary-soft' : 'border-border-strong',
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          multiple={multiple}
          accept={accept}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void start(e.target.files);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          onClick={() => inputRef.current?.click()}
        >
          <Upload aria-hidden="true" className="h-4 w-4" />
          {label}
        </Button>
        <label htmlFor={inputId} className="text-xs text-fg-muted">
          {hint ??
            'Drag files here or choose them. Files are scanned before they become available.'}
        </label>
      </div>
      {precheck.length > 0 ? (
        <Alert tone="warning" title="Some files were not uploaded">
          <ul className="list-disc pl-5">
            {precheck.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {items.length > 0 ? (
        <ul className="space-y-2" aria-live="polite">
          {items.map((item) => (
            <li key={item.key} className="rounded-md border border-border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="text-xs text-fg-muted">
                    {formatBytes(item.size)} · {phaseLabel(item)}
                  </p>
                </div>
                {item.progress.phase === 'uploading' || item.progress.phase === 'preparing' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Cancel upload of ${item.name}`}
                    onClick={() => item.controller.abort()}
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              {item.progress.percent !== null &&
              item.progress.phase !== 'done' &&
              item.progress.phase !== 'failed' ? (
                <progress
                  className="mt-2 h-2 w-full"
                  max={100}
                  value={item.progress.percent}
                  aria-label={`${item.name} upload progress`}
                />
              ) : null}
              {item.error ? (
                <p role="alert" className="mt-2 text-danger">
                  {item.error.message}
                  {item.error.correlationId ? (
                    <span className="block text-xs text-fg-subtle">
                      Reference: {item.error.correlationId}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function phaseLabel(item: Item): string {
  const p = item.progress;
  switch (p.phase) {
    case 'preparing':
      return 'Preparing (computing checksum and requesting an upload slot)';
    case 'uploading':
      return p.partsTotal
        ? `Uploading part ${Math.min((p.partsDone ?? 0) + 1, p.partsTotal)} of ${p.partsTotal} · ${p.percent ?? 0}%`
        : `Uploading · ${p.percent ?? 0}%`;
    case 'finalizing':
      return 'Verifying the uploaded bytes';
    case 'scanning':
      return 'Uploaded; scanning for malware';
    case 'done':
      return 'Scanned clean and available';
    case 'failed':
      return item.file ? `Not available (${item.file.status.replace(/_/g, ' ')})` : 'Failed';
    default:
      return p.phase;
  }
}

'use client';

import type { EvidenceDto } from '@simplexd/contracts';
import { Badge, EmptyState, formatDateTimeLabel, humanize } from '@simplexd/ui';
import { SignedDownloadButton, SignedImage } from './signed-download';

/**
 * Approved evidence with thumbnails served through signed `?variant=thumb`
 * URLs (originals are never public). Non-image evidence lists a download.
 */
export function EvidenceGallery({ items, zone }: { items: EvidenceDto[]; zone: string }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No approved media yet"
        description="Photos, video and drawings appear here once an inspector uploads them and a reviewer approves them for you."
      />
    );
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((e) => {
        const isImage =
          e.kind === 'photo' ||
          e.kind === 'drone' ||
          (e.file?.declaredMime.startsWith('image/') ?? false);
        const name = e.file?.originalName ?? 'evidence';
        const alt = e.caption ?? `${humanize(e.kind)} ${name}`;
        const scanned = e.file?.status === 'clean';
        return (
          <li key={e.id} className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
            <div className="aspect-[4/3] w-full bg-bg-sunken">
              {isImage && scanned ? (
                <SignedImage
                  fileId={e.redactedFileId ?? e.fileId}
                  alt={alt}
                  variant="thumb"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-fg-muted">
                  {humanize(e.kind)} ·{' '}
                  {scanned
                    ? 'no preview'
                    : `file ${e.file?.status.replace(/_/g, ' ') ?? 'unavailable'}`}
                </div>
              )}
            </div>
            <div className="space-y-2 p-3 text-sm">
              <p className="font-medium">{e.caption ?? name}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <Badge tone="neutral">{humanize(e.kind)}</Badge>
                {e.publication === 'redacted_public' ? (
                  <Badge tone="info">Redacted copy</Badge>
                ) : null}
                <span>Received {formatDateTimeLabel(e.receivedAt, zone)}</span>
              </p>
              {e.capturedAt ? (
                <p className="text-xs text-fg-muted">
                  Captured (as declared by the uploader) {formatDateTimeLabel(e.capturedAt, zone)}
                </p>
              ) : null}
              <SignedDownloadButton
                fileId={e.redactedFileId ?? e.fileId}
                fileName={name}
                status={e.file?.status ?? 'clean'}
                inline={isImage}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

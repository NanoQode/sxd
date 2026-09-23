'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  ContentMediaAssetDto,
  ContentMediaListResponse,
  ContentMediaPendingDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  humanize,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { FileUploader } from '@/components/portal/file-uploader';

/**
 * Content media picker. Three honest states for every file: uploading and
 * scanning (shared file pipeline, purpose content_media), awaiting approval
 * by a content editor other than the uploader (alt text and rights
 * confirmation required), and approved with a public URL under /media/{id}.
 * Private evidence and documents never appear here: the listing is limited
 * to content_media and the public route refuses everything else.
 */
export function MediaPicker({
  open,
  onOpenChange,
  pageId,
  currentUserId,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  currentUserId: string;
  onInsert: (asset: ContentMediaAssetDto) => void;
}) {
  const { toast } = useToast();
  const [data, setData] = useState<ContentMediaListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<ContentMediaListResponse>('/api/v1/admin/content/media'));
    } catch (err) {
      setError(errorMessage(err));
      setData((prev) => prev ?? { items: [], pending: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const pending = data?.pending ?? [];
  const items = data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Content media"
        description="Images are uploaded to quarantine, scanned, converted to WebP and then approved by a second content editor with alt text and confirmed rights. Only approved images have a public URL; documents, video originals and private evidence are never served publicly."
        size="lg"
      >
        <div className="space-y-6">
          {error ? (
            <Alert tone="danger" title="Media could not be loaded">
              {error}
            </Alert>
          ) : null}

          <section aria-labelledby="media-upload-heading" className="space-y-2">
            <h3 id="media-upload-heading" className="text-sm font-semibold">
              Upload an image
            </h3>
            <FileUploader
              purpose="content_media"
              entityType="content_page"
              entityId={pageId}
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              label="Choose image"
              hint="JPEG, PNG, WebP or HEIC up to 25 MB. Scanned before it can be approved; someone other than you must approve it."
              refreshOnSettle={false}
              compact
              onUploaded={() => void load()}
            />
          </section>

          <section aria-labelledby="media-pending-heading" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="media-pending-heading" className="text-sm font-semibold">
                Awaiting approval ({pending.length})
              </h3>
              <Button variant="ghost" size="sm" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
            {pending.length === 0 ? (
              <p className="text-sm text-fg-muted">No uploads are waiting.</p>
            ) : (
              <ul className="space-y-2">
                {pending.map((p) => (
                  <PendingRow
                    key={p.fileId}
                    file={p}
                    ownUpload={p.ownerUserId === currentUserId}
                    onChanged={() => {
                      toast({ title: 'Approved for public use', tone: 'success' });
                      void load();
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="media-approved-heading" className="space-y-2">
            <h3 id="media-approved-heading" className="text-sm font-semibold">
              Approved ({items.length})
            </h3>
            {data === null ? (
              <p className="text-sm text-fg-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No approved media yet. Upload an image above; once it is scanned clean, a second
                content editor approves it here with alt text and a rights confirmation.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {items.map((m) => (
                  <li key={m.id} className="flex gap-3 rounded-md border border-border p-3 text-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element -- public route, not an optimisable remote */}
                    <img
                      src={m.thumbUrl}
                      alt=""
                      width={64}
                      height={64}
                      loading="lazy"
                      className="h-16 w-16 shrink-0 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{m.altText}</p>
                      <p className="truncate text-xs text-fg-muted">
                        {m.originalName}
                        {m.rightsConfirmed ? ' · rights confirmed' : ' · rights unconfirmed'}
                      </p>
                      <p className="truncate font-mono text-xs text-fg-subtle">{m.publicUrl}</p>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-2"
                        onClick={() => onInsert(m)}
                      >
                        Insert
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function statusTone(status: ContentMediaPendingDto['status']): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (status) {
    case 'clean':
      return 'info';
    case 'scanning':
    case 'uploaded':
      return 'neutral';
    case 'scan_failed':
      return 'warning';
    default:
      return 'danger';
  }
}

function PendingRow({
  file,
  ownUpload,
  onChanged,
}: {
  file: ContentMediaPendingDto;
  ownUpload: boolean;
  onChanged: () => void;
}) {
  const [altText, setAltText] = useState('');
  const [caption, setCaption] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvable = file.status === 'clean' && file.hasWebVariant && !ownUpload;

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/files/${file.fileId}/public-approval`, {
        method: 'POST',
        body: {
          approved: true,
          altText: altText.trim(),
          caption: caption.trim() || undefined,
          rightsConfirmed: rights,
        },
      });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate font-medium">{file.originalName}</span>
          <span className="block text-xs text-fg-muted">
            {file.declaredMime} · uploaded by {ownUpload ? 'you' : (file.ownerName ?? 'unknown')}
          </span>
        </span>
        <Badge tone={statusTone(file.status)}>{humanize(file.status)}</Badge>
      </div>
      {file.statusReason ? (
        <p className="mt-1 text-xs text-danger">{file.statusReason}</p>
      ) : file.status === 'scanning' || file.status === 'uploaded' ? (
        <p className="mt-1 text-xs text-fg-muted">Scanning for malware; refresh shortly.</p>
      ) : file.status === 'clean' && !file.hasWebVariant ? (
        <p className="mt-1 text-xs text-fg-muted">
          Scanned clean; the WebP version is still being generated. Refresh shortly.
        </p>
      ) : ownUpload ? (
        <p className="mt-1 text-xs text-fg-muted">
          Scanned clean. You uploaded this image, so another content editor must approve it.
        </p>
      ) : null}
      {approvable ? (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <Field label="Alt text" required hint="Describes the image for screen readers.">
            {({ id }) => (
              <Input
                id={id}
                value={altText}
                onChange={(e) => setAltText(e.target.value)}
                maxLength={500}
                required
              />
            )}
          </Field>
          <Field label="Caption">
            {({ id }) => (
              <Input
                id={id}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={1000}
              />
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              required
            />
            <span>
              SimplexD holds the rights to publish this image (owner consent or licence recorded).
            </span>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              {error}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              loading={busy}
              loadingLabel="Approving"
              disabled={!altText.trim() || !rights}
            >
              Approve for public use
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

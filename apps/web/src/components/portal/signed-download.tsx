'use client';

import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, useToast } from '@simplexd/ui';
import { describeError, requestDownloadUrl } from '@/lib/portal/client';

/**
 * Asks the API for a short-lived signed URL at click time (access is
 * re-evaluated on every call) and opens it. Quarantined or rejected files
 * explain themselves instead of failing silently.
 */
export function SignedDownloadButton({
  fileId,
  fileName,
  status,
  variant = 'secondary',
  size = 'sm',
  inline = false,
  label,
}: {
  fileId: string;
  fileName: string;
  status: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'link';
  size?: 'sm' | 'md';
  inline?: boolean;
  label?: string;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const ready = status === 'clean';
  const reason =
    status === 'clean'
      ? null
      : status === 'scanning' || status === 'uploaded'
        ? 'Still being scanned for malware; try again in a moment.'
        : status === 'pending_upload'
          ? 'The upload never completed.'
          : status === 'scan_failed'
            ? 'The scanner failed; the team has been notified.'
            : 'This file was rejected and cannot be downloaded.';

  async function open() {
    setBusy(true);
    try {
      const { url } = await requestDownloadUrl(fileId, inline ? { disposition: 'inline' } : {});
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) window.location.assign(url);
    } catch (err) {
      const e = describeError(err);
      toast({
        title: 'Download not available',
        description: e.correlationId
          ? `${e.message} (ref ${e.correlationId.slice(0, 8)})`
          : e.message,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => void open()}
      loading={busy}
      disabled={!ready}
      title={reason ?? `Download ${fileName}`}
      aria-label={label ?? `${inline ? 'Open' : 'Download'} ${fileName}`}
    >
      {inline ? (
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      ) : (
        <Download aria-hidden="true" className="h-4 w-4" />
      )}
      {label ?? (inline ? 'Open' : 'Download')}
    </Button>
  );
}

/** Loads a thumbnail through a signed URL; renders a labelled placeholder until it resolves. */
export function SignedImage({
  fileId,
  alt,
  variant = 'thumb',
  className,
}: {
  fileId: string;
  alt: string;
  variant?: 'thumb' | 'web';
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestDownloadUrl(fileId, { variant })
      .then((r) => {
        if (!cancelled) setSrc(r.url);
      })
      .catch((err) => {
        if (!cancelled) setFailed(describeError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, variant]);
  if (failed) {
    return (
      <div role="img" aria-label={`${alt} (preview unavailable: ${failed})`} className={className}>
        <span className="flex h-full w-full items-center justify-center bg-bg-sunken p-2 text-center text-xs text-fg-muted">
          Preview unavailable
        </span>
      </div>
    );
  }
  if (!src) {
    return (
      <div
        role="status"
        aria-label={`Loading preview of ${alt}`}
        className={`sx-skeleton ${className ?? ''}`}
      />
    );
  }
  // Signed storage URLs are short-lived and not on the next/image allow-list.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}

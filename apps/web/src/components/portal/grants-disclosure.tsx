'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FileGrantDto } from '@simplexd/contracts';
import { Button, formatDateTimeLabel } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';

/**
 * Who else was granted access to a file. Loaded on demand; the API allows
 * the owner and staff to list grants, so members see an honest explanation.
 */
export function GrantsDisclosure({ fileId, ownedByMe }: { fileId: string; ownedByMe: boolean }) {
  const [open, setOpen] = useState(false);
  const grants = useQuery({
    queryKey: ['file-grants', fileId],
    enabled: open,
    queryFn: () => portalFetch<{ items: FileGrantDto[] }>(`/api/v1/files/${fileId}/grants`),
    retry: false,
  });
  if (!open) {
    return (
      <Button type="button" variant="link" size="sm" onClick={() => setOpen(true)}>
        {ownedByMe ? 'Who can see this' : 'Access'}
      </Button>
    );
  }
  if (grants.isLoading) return <span className="text-xs text-fg-muted">Loading…</span>;
  if (grants.isError) {
    const e = describeError(grants.error);
    return (
      <span className="text-xs text-fg-muted">
        {e.status === 403 || e.status === 404
          ? 'Organisation members and the assigned team; extra grants are visible to the uploader only.'
          : e.message}
      </span>
    );
  }
  const items = grants.data?.items.filter((g) => !g.revokedAt) ?? [];
  return (
    <span className="text-xs text-fg-muted">
      Organisation members
      {items.length > 0
        ? `; plus ${items.map((g) => `${g.userId ? 'a named user' : 'an organisation'} (${g.level}${g.expiresAt ? `, until ${formatDateTimeLabel(g.expiresAt)}` : ''})`).join(', ')}`
        : '; no extra grants'}
    </span>
  );
}

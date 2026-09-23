'use client';

import { Check, Mail, MailOpen } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TenantNoticeDto } from '@simplexd/contracts';
import { Badge, Button, formatDateTimeLabel, useToast } from '@simplexd/ui';
import { describeTenantError, tenantFetch } from '@/lib/tenant/client';

/**
 * Approved notices addressed to the caller (posted by the landlord or staff
 * on their lease). Marking one read is the caller's own notification state.
 */
export function NoticeList({
  notices,
  zone,
  leaseTitles,
  compact = false,
}: {
  notices: TenantNoticeDto[];
  zone: string;
  leaseTitles: Record<string, string>;
  compact?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  async function markRead(id: string) {
    setBusyId(id);
    try {
      await tenantFetch(`/api/v1/notifications/${id}/read`, { method: 'POST', body: {} });
      setReadIds((prev) => new Set(prev).add(id));
      router.refresh();
    } catch (err) {
      const e = describeTenantError(err);
      toast({
        title: 'Could not mark the notice as read',
        description: e.correlationId ? `${e.message} (ref ${e.correlationId})` : e.message,
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ul className="space-y-3">
      {notices.map((n) => {
        const read = Boolean(n.readAt) || readIds.has(n.id);
        const lease = n.leaseId ? leaseTitles[n.leaseId] : undefined;
        return (
          <li key={n.id}>
            <article
              aria-labelledby={`notice-${n.id}`}
              className="rounded-lg border border-border bg-bg-elevated p-4"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 id={`notice-${n.id}`} className="font-medium break-words">
                    {n.title}
                  </h3>
                  <p className="text-xs text-fg-muted">
                    <time dateTime={n.createdAt}>{formatDateTimeLabel(n.createdAt, zone)}</time>
                    {lease ? (
                      <>
                        {' · '}
                        <Link href={`/tenant/lease/${n.leaseId}`} className="underline">
                          {lease}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                {read ? (
                  <Badge tone="neutral">
                    <MailOpen aria-hidden="true" className="h-3 w-3" />
                    Read
                  </Badge>
                ) : (
                  <Badge tone="primary">
                    <Mail aria-hidden="true" className="h-3 w-3" />
                    New
                  </Badge>
                )}
              </header>
              {n.body && !compact ? (
                <p className="mt-2 text-sm whitespace-pre-wrap">{n.body}</p>
              ) : null}
              {n.body && compact ? (
                <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{n.body}</p>
              ) : null}
              {!read && !compact ? (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void markRead(n.id)}
                    loading={busyId === n.id}
                    loadingLabel="Saving"
                    aria-label={`Mark “${n.title}” as read`}
                  >
                    <Check aria-hidden="true" className="h-4 w-4" />
                    Mark as read
                  </Button>
                </div>
              ) : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

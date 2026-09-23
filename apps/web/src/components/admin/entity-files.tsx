import type { FileEntityType } from '@simplexd/contracts';
import { Badge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { listFilesForEntity } from '@/server/files/queries';
import { LoadError } from './load-error';

function size(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Documents attached to a record, filtered by the same access policy as
 * downloads. Only files that passed the malware scan can be downloaded; the
 * link issues a short-lived signed URL.
 */
export async function EntityFiles({
  identity,
  entityType,
  entityId,
}: {
  identity: RequestIdentity;
  entityType: FileEntityType;
  entityId: string;
}) {
  const res = await attempt(() =>
    listFilesForEntity(identity, { entityType, entityId, limit: 50 }),
  );
  if (!res.ok) return <LoadError code={res.code} message={res.message} what="Documents" />;
  const files = res.value.items;
  if (files.length === 0)
    return (
      <p className="text-fg-muted">
        No documents attached. Customers upload from their portal; field evidence comes from site
        visits.
      </p>
    );
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words">
            {f.status === 'clean' ? (
              <a href={`/api/v1/files/${f.id}/download`} className="underline">
                {f.originalName}
              </a>
            ) : (
              <span>{f.originalName}</span>
            )}{' '}
            <span className="text-xs text-fg-muted">
              {humanize(String(f.purpose))} · {size(f.sizeBytes)} ·{' '}
              {formatDateTimeLabel(f.createdAt)}
            </span>
          </span>
          <span className="flex items-center gap-1">
            {f.sensitive ? <Badge tone="warning">sensitive</Badge> : null}
            <Badge
              tone={
                f.status === 'clean'
                  ? 'success'
                  : ['infected', 'rejected', 'scan_failed'].includes(f.status)
                    ? 'danger'
                    : 'neutral'
              }
            >
              {humanize(f.status)}
            </Badge>
          </span>
          {f.statusReason && f.status !== 'clean' ? (
            <span className="w-full text-xs text-danger">{f.statusReason}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

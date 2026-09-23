import type { AuditEventDto } from '@simplexd/contracts';
import { DataTable, type Column } from '@simplexd/ui';
import { JsonBlock, fmtDate } from './bits';

/** Read-only audit entries with before/after payloads (server-safe). */
export function AuditTable({ items, caption = 'Audit entries' }: { items: AuditEventDto[]; caption?: string }) {
  const columns: Column<AuditEventDto>[] = [
    { key: 'when', header: 'When', cell: (e) => <span className="whitespace-nowrap text-xs">{fmtDate(e.createdAt)}</span> },
    {
      key: 'actor',
      header: 'Actor',
      cell: (e) => (
        <span className="text-xs">
          {e.actorName ?? e.actorUserId ?? e.actorType}
          <span className="block text-fg-muted">{e.actorType}</span>
        </span>
      ),
    },
    { key: 'action', header: 'Action', cell: (e) => <code className="font-mono text-xs">{e.action}</code> },
    {
      key: 'entity',
      header: 'Entity',
      cell: (e) => (
        <span className="text-xs">
          {e.entityType}
          {e.entityId ? <span className="block break-all font-mono text-fg-muted">{e.entityId}</span> : null}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (e) => <span className="text-xs">{e.reason ?? '—'}</span> },
    {
      key: 'change',
      header: 'Before / after',
      hideOnMobile: true,
      cell: (e) =>
        e.before || e.after ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-primary">View</summary>
            <div className="mt-1 grid grid-cols-1 gap-2 lg:grid-cols-2">
              <div>
                <p className="mb-1 font-medium">Before</p>
                <JsonBlock value={e.before} />
              </div>
              <div>
                <p className="mb-1 font-medium">After</p>
                <JsonBlock value={e.after} />
              </div>
            </div>
          </details>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={items}
      rowKey={(e) => e.id}
      rowLabel={(e) => `${e.action} ${e.entityType}`}
      caption={caption}
      emptyMessage="No audit entries yet."
    />
  );
}

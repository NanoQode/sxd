'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { MarketRevisionDto } from '@simplexd/contracts';
import { Alert, Button, DataTable, useToast, type Column } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../../../_components/action-dialog';
import { fmtDate } from '../../../../_components/bits';

function diff(left: Record<string, unknown>, right: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.map((field) => ({
    field,
    left: left[field] ?? null,
    right: right[field] ?? null,
    changed: JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null),
  }));
}

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Revision list, side-by-side diff of any two snapshots, and rollback (which creates a new revision). */
export function RevisionsTab({
  marketId,
  currentVersion,
  items,
  canEdit,
}: {
  marketId: string;
  currentVersion: number;
  items: MarketRevisionDto[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [a, setA] = useState<number | null>(items[1]?.version ?? null);
  const [b, setB] = useState<number | null>(items[0]?.version ?? null);
  const [rollback, setRollback] = useState<MarketRevisionDto | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);

  const lines = useMemo(() => {
    const left = items.find((r) => r.version === a);
    const right = items.find((r) => r.version === b);
    if (!left || !right) return [];
    return diff(left.snapshot, right.snapshot).filter((l) => !onlyChanged || l.changed);
  }, [items, a, b, onlyChanged]);

  async function doRollback(reason: string) {
    if (!rollback) return;
    await apiFetch(`/api/v1/admin/markets/${marketId}/rollback`, {
      method: 'POST',
      body: { revisionVersion: rollback.version, expectedVersion: currentVersion, reason },
    });
    toast({ title: `Rolled back to revision ${rollback.version}`, description: 'A new revision was created and audited.', tone: 'success' });
    router.refresh();
  }

  const columns: Column<MarketRevisionDto>[] = [
    { key: 'version', header: 'Version', cell: (r) => <span className="font-mono">v{r.version}{r.version === currentVersion ? <span className="ml-1 text-xs text-fg-muted">(current)</span> : null}</span> },
    { key: 'reason', header: 'Change reason', cell: (r) => r.changeReason ?? '—' },
    { key: 'by', header: 'By', cell: (r) => r.changedByName ?? r.changedBy ?? 'import' },
    { key: 'when', header: 'When', cell: (r) => <span className="text-xs">{fmtDate(r.createdAt)}</span> },
    {
      key: 'actions',
      header: 'Actions',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setA(r.version)} aria-pressed={a === r.version}>Left</Button>
          <Button size="sm" variant="ghost" onClick={() => setB(r.version)} aria-pressed={b === r.version}>Right</Button>
          {canEdit && r.version !== currentVersion ? <Button size="sm" variant="secondary" onClick={() => setRollback(r)}>Roll back to this</Button> : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <Alert tone="info" title="History is never rewritten">
        Every edit, publication change and rollback appends a revision. Rolling back restores the content fields of an earlier revision as a new version, keeping publication state as it is.
      </Alert>
      <DataTable columns={columns} rows={items} rowKey={(r) => r.id} rowLabel={(r) => `Revision ${r.version}`} caption="Revisions" emptyMessage="No revisions recorded yet; the first edit captures the imported baseline." />
      {a !== null && b !== null ? (
        <section aria-labelledby="rev-diff" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="rev-diff" className="text-base font-semibold">
              Compare v{a} (left) with v{b} (right)
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[var(--sx-primary)]" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
              Changed fields only
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Side-by-side revision diff</caption>
              <thead className="bg-bg-sunken text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Field</th>
                  <th scope="col" className="px-3 py-2 font-medium">v{a}</th>
                  <th scope="col" className="px-3 py-2 font-medium">v{b}</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-4 text-center text-fg-muted">No differences.</td></tr>
                ) : null}
                {lines.map((l) => (
                  <tr key={l.field} className={l.changed ? 'border-t border-border bg-warning-soft/40' : 'border-t border-border'}>
                    <th scope="row" className="px-3 py-2 text-left font-mono text-xs font-medium">{l.field}</th>
                    <td className="px-3 py-2 align-top break-all font-mono text-xs">{show(l.left)}</td>
                    <td className="px-3 py-2 align-top break-all font-mono text-xs">{show(l.right)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <ActionDialog
        open={rollback !== null}
        onOpenChange={(o) => !o && setRollback(null)}
        title={rollback ? `Roll back to revision ${rollback.version}` : ''}
        description="Restores the content fields of that revision as a new revision. Publication state does not change."
        confirmLabel="Roll back"
        tone="danger"
        requireReason
        onConfirm={doRollback}
      />
    </div>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Textarea } from '@simplexd/ui';
import { errorMessage } from '@/lib/admin/client';

export interface BulkItem {
  id: string;
  label: string;
}

export interface BulkAction {
  key: string;
  label: string;
  /** Describes what will happen; shown above the preview list. */
  description: ReactNode;
  requireReason?: boolean;
  tone?: 'primary' | 'danger';
  /** Optional per-item eligibility check; ineligible rows are listed but skipped. */
  eligible?: (item: BulkItem) => string | null;
  /** Extra form controls rendered inside the dialog. */
  form?: ReactNode;
  /** Disable the confirm button until the extra form is valid. */
  ready?: boolean;
  run: (item: BulkItem, reason: string) => Promise<string>;
}

interface Outcome {
  id: string;
  label: string;
  status: 'skipped' | 'ok' | 'failed';
  detail: string;
}

/**
 * Bulk actions with a preview: the dialog lists every selected row and the
 * reason it would be skipped, executes sequentially and reports per-row
 * outcomes. Nothing runs until the person confirms the preview.
 */
export function BulkActionBar({
  selected,
  actions,
  onDone,
  onClear,
}: {
  selected: BulkItem[];
  actions: BulkAction[];
  onDone?: () => void;
  onClear: () => void;
}) {
  const [active, setActive] = useState<BulkAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (selected.length === 0) return null;

  const preview = active
    ? selected.map((item) => ({ item, skip: active.eligible ? active.eligible(item) : null }))
    : [];
  const runnable = preview.filter((p) => !p.skip).length;

  function close() {
    if (busy) return;
    setActive(null);
    setReason('');
    setOutcomes(null);
    setError(null);
  }

  async function execute() {
    if (!active) return;
    setBusy(true);
    setError(null);
    const results: Outcome[] = [];
    for (const { item, skip } of preview) {
      if (skip) {
        results.push({ id: item.id, label: item.label, status: 'skipped', detail: skip });
        continue;
      }
      try {
        const detail = await active.run(item, reason.trim());
        results.push({ id: item.id, label: item.label, status: 'ok', detail });
      } catch (err) {
        results.push({ id: item.id, label: item.label, status: 'failed', detail: errorMessage(err) });
      }
    }
    setOutcomes(results);
    setBusy(false);
    onDone?.();
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary-soft/40 p-3 text-sm"
    >
      <span className="font-medium">{selected.length} selected</span>
      {actions.map((a) => (
        <Button key={a.key} variant="secondary" size="sm" onClick={() => setActive(a)}>
          {a.label}
        </Button>
      ))}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear selection
      </Button>
      <Dialog open={Boolean(active)} onOpenChange={(v) => !v && close()}>
        <DialogContent
          title={active ? `${active.label}: preview` : 'Preview'}
          description={active?.description}
          size="lg"
        >
          {outcomes ? (
            <div className="space-y-3">
              <Alert
                tone={outcomes.some((o) => o.status === 'failed') ? 'warning' : 'success'}
                title={`${outcomes.filter((o) => o.status === 'ok').length} succeeded, ${outcomes.filter((o) => o.status === 'failed').length} failed, ${outcomes.filter((o) => o.status === 'skipped').length} skipped`}
              >
                Each row below shows the server outcome. Nothing was retried automatically.
              </Alert>
              <ul className="max-h-72 space-y-1 overflow-auto text-sm">
                {outcomes.map((o) => (
                  <li key={o.id} className="flex flex-wrap gap-x-2 rounded-md border border-border px-2 py-1">
                    <span className="font-medium">{o.label}</span>
                    <span
                      className={
                        o.status === 'ok'
                          ? 'text-success'
                          : o.status === 'failed'
                            ? 'text-danger'
                            : 'text-fg-muted'
                      }
                    >
                      {o.status}
                    </span>
                    <span className="text-fg-muted">{o.detail}</span>
                  </li>
                ))}
              </ul>
              <DialogFooter>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              {error ? (
                <Alert tone="danger" title="Could not run">
                  {error}
                </Alert>
              ) : null}
              {active?.form}
              <p className="text-sm text-fg-muted">
                {runnable} of {preview.length} selected rows will be processed, one server call each.
              </p>
              <ul className="max-h-60 space-y-1 overflow-auto text-sm">
                {preview.map(({ item, skip }) => (
                  <li key={item.id} className="flex flex-wrap gap-x-2 rounded-md border border-border px-2 py-1">
                    <span className={skip ? 'text-fg-muted line-through' : 'font-medium'}>{item.label}</span>
                    {skip ? <span className="text-warning">Skipped: {skip}</span> : <span className="text-fg-muted">Will run</span>}
                  </li>
                ))}
              </ul>
              {active?.requireReason ? (
                <Field label="Reason (recorded in the audit log)" required hint="At least 3 characters.">
                  {({ id }) => (
                    <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20" />
                  )}
                </Field>
              ) : null}
              <DialogFooter>
                <Button variant="secondary" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant={active?.tone === 'danger' ? 'danger' : 'primary'}
                  loading={busy}
                  loadingLabel="Running"
                  disabled={
                    runnable === 0 ||
                    (active?.requireReason ? reason.trim().length < 3 : false) ||
                    (active?.ready === false)
                  }
                  onClick={() => void execute()}
                >
                  Run for {runnable} row{runnable === 1 ? '' : 's'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

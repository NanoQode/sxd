'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, DataTable, Dialog, DialogContent, DialogFooter, Field, Input, NativeSelect, Textarea, useToast, type Column } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import type { MarketFlagDto } from '@/server/admin/market-data/flags';
import { ActionDialog } from '../../../../_components/action-dialog';
import { fmtDate } from '../../../../_components/bits';
import { humanize } from '../../../_lib/params';

const FLAG_TYPES = ['geographic_exclusion', 'title_stop', 'site_restriction', 'flood_alert', 'security_advisory', 'data_dispute'] as const;
const APPROVER_ONLY = new Set(['geographic_exclusion', 'title_stop', 'site_restriction']);

export function FlagsTab({
  marketId,
  items,
  sources,
  neighborhoods,
  canEdit,
  canPublish,
}: {
  marketId: string;
  items: MarketFlagDto[];
  sources: Array<{ id: string; title: string }>;
  neighborhoods: Array<{ id: string; name: string }>;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ flagType: 'data_dispute' as (typeof FLAG_TYPES)[number], note: '', neighborhoodId: '', sourceId: '', validFrom: '', validUntil: '' });
  const [toggle, setToggle] = useState<MarketFlagDto | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/markets/${marketId}/flags`, {
        body: { flagType: form.flagType, note: form.note, neighborhoodId: form.neighborhoodId || null, sourceId: form.sourceId || null, validFrom: form.validFrom || null, validUntil: form.validUntil || null, active: true },
      });
      toast({ title: 'Flag created', tone: 'success' });
      setOpen(false);
      setForm({ flagType: 'data_dispute', note: '', neighborhoodId: '', sourceId: '', validFrom: '', validUntil: '' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyToggle(reason: string) {
    if (!toggle) return;
    await apiFetch(`/api/v1/admin/markets/${marketId}/flags/${toggle.id}`, { method: 'PATCH', body: { active: !toggle.active, reason, expectedUpdatedAt: toggle.updatedAt } });
    toast({ title: `Flag ${toggle.active ? 'deactivated' : 'reactivated'}`, tone: 'success' });
    router.refresh();
  }

  const canChange = (t: string) => (APPROVER_ONLY.has(t) ? canPublish : canEdit || canPublish);

  const columns: Column<MarketFlagDto>[] = [
    { key: 'type', header: 'Flag', cell: (f) => <Badge tone={f.active ? (APPROVER_ONLY.has(f.flagType) ? 'danger' : 'warning') : 'neutral'}>{humanize(f.flagType)}</Badge> },
    { key: 'note', header: 'Note', cell: (f) => <span className="text-sm">{f.note}</span> },
    { key: 'validity', header: 'Valid', cell: (f) => <span className="text-xs text-fg-muted">{f.validFrom ?? '…'} → {f.validUntil ?? '…'}</span> },
    { key: 'active', header: 'Active', cell: (f) => (f.active ? 'Yes' : 'No') },
    { key: 'created', header: 'Created', hideOnMobile: true, cell: (f) => <span className="text-xs text-fg-muted">{fmtDate(f.createdAt)}</span> },
    { key: 'actions', header: 'Actions', cell: (f) => (canChange(f.flagType) ? <Button size="sm" variant="secondary" onClick={() => setToggle(f)}>{f.active ? 'Deactivate' : 'Reactivate'}</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Flags never certify safety">
        Exclusions, title stops and site restrictions block ranking and need the approver. Advisories are shown to customers as dated, attributed context. Unknown flood or title status is never shown as low risk.
      </Alert>
      <div className="flex justify-end">{canEdit || canPublish ? <Button size="sm" onClick={() => setOpen(true)}>Add flag</Button> : null}</div>
      <DataTable columns={columns} rows={items} rowKey={(f) => f.id} rowLabel={(f) => humanize(f.flagType)} caption="Market flags" emptyMessage="No flags." />

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent title="Add flag">
          <div className="space-y-4">
            {error ? <Alert tone="danger" title="Could not create the flag">{error}</Alert> : null}
            <Field label="Type" required hint={APPROVER_ONLY.has(form.flagType) ? 'Blocking flag: requires the approver permission.' : undefined}>
              {({ id }) => (
                <NativeSelect id={id} value={form.flagType} onChange={(e) => setForm((f) => ({ ...f, flagType: e.target.value as (typeof FLAG_TYPES)[number] }))}>
                  {FLAG_TYPES.filter((t) => canChange(t)).map((t) => (
                    <option key={t} value={t}>{humanize(t)}</option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Note" required hint="What was observed, by whom, and the source.">
              {({ id }) => <Textarea id={id} className="min-h-24" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />}
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Neighborhood (optional)">
                {({ id }) => (
                  <NativeSelect id={id} value={form.neighborhoodId} onChange={(e) => setForm((f) => ({ ...f, neighborhoodId: e.target.value }))}>
                    <option value="">Whole market</option>
                    {neighborhoods.map((n) => (
                      <option key={n.id} value={n.id}>{n.name}</option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Source (optional)">
                {({ id }) => (
                  <NativeSelect id={id} value={form.sourceId} onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}>
                    <option value="">None</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>{s.title}</option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Valid from">
                {({ id }) => <Input id={id} type="date" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} />}
              </Field>
              <Field label="Valid until">
                {({ id }) => <Input id={id} type="date" value={form.validUntil} onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />}
              </Field>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button onClick={create} loading={busy} loadingLabel="Saving" disabled={form.note.trim().length < 3}>Create flag</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ActionDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle ? `${toggle.active ? 'Deactivate' : 'Reactivate'} ${humanize(toggle.flagType)}` : ''}
        confirmLabel={toggle?.active ? 'Deactivate' : 'Reactivate'}
        tone={toggle?.active ? 'danger' : 'primary'}
        requireReason
        onConfirm={applyToggle}
      />
    </div>
  );
}

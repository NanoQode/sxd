'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, DataTable, Dialog, DialogContent, DialogFooter, Field, Input, NativeSelect, Textarea, useToast, type Column } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import type { SourceDto } from '@/server/admin/market-data/sources';
import { fmtDay } from '../../_components/bits';
import { humanize } from '../_lib/params';

const RIGHTS = ['unknown', 'attribution_required', 'licensed_commercial', 'first_party', 'restricted_factual_reference'] as const;

interface FormState {
  slug: string;
  title: string;
  publisher: string;
  url: string;
  dataUrl: string;
  licenseNote: string;
  licenseRights: (typeof RIGHTS)[number];
  useNote: string;
  retrievedAt: string;
  reason: string;
}

const empty: FormState = { slug: '', title: '', publisher: '', url: '', dataUrl: '', licenseNote: '', licenseRights: 'unknown', useNote: '', retrievedAt: '', reason: '' };

export function SourcesManager({ items, canEdit }: { items: SourceDto[]; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<SourceDto | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  function open(s: SourceDto | 'new') {
    setEditing(s);
    setError(null);
    setForm(s === 'new' ? empty : { slug: s.slug, title: s.title, publisher: s.publisher ?? '', url: s.url ?? '', dataUrl: s.dataUrl ?? '', licenseNote: s.licenseNote ?? '', licenseRights: s.licenseRights, useNote: s.useNote ?? '', retrievedAt: s.retrievedAt ?? '', reason: '' });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { title: form.title.trim(), publisher: form.publisher || null, url: form.url || null, dataUrl: form.dataUrl || null, licenseNote: form.licenseNote || null, licenseRights: form.licenseRights, useNote: form.useNote || null, retrievedAt: form.retrievedAt || null };
      if (editing === 'new') {
        await apiFetch('/api/v1/admin/sources', { body: { ...body, slug: form.slug.trim() } });
        toast({ title: 'Source registered', tone: 'success' });
      } else if (editing) {
        if (form.reason.trim().length < 3) throw new Error('Give a reason for the change.');
        await apiFetch(`/api/v1/admin/sources/${editing.id}`, { method: 'PATCH', body: { ...body, reason: form.reason, expectedUpdatedAt: editing.updatedAt } });
        toast({ title: 'Source updated', tone: 'success' });
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const filtered = items.filter((s) => !q || `${s.title} ${s.slug} ${s.publisher ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<SourceDto>[] = [
    { key: 'title', header: 'Source', cell: (s) => <span className="font-medium">{s.title}<span className="block font-mono text-xs text-fg-muted">{s.slug}{s.publisher ? ` · ${s.publisher}` : ''}</span></span> },
    { key: 'url', header: 'URL', hideOnMobile: true, cell: (s) => (s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-primary underline">{s.url}</a> : '—') },
    { key: 'rights', header: 'Rights', cell: (s) => <Badge tone={s.licenseRights === 'first_party' || s.licenseRights === 'licensed_commercial' ? 'success' : s.licenseRights === 'unknown' ? 'warning' : 'neutral'}>{humanize(s.licenseRights)}</Badge> },
    { key: 'license', header: 'License / use', hideOnMobile: true, cell: (s) => <span className="text-xs text-fg-muted">{s.licenseNote ?? '—'}{s.useNote ? ` · ${s.useNote}` : ''}</span> },
    { key: 'retrieved', header: 'Retrieved', cell: (s) => fmtDay(s.retrievedAt) },
    { key: 'obs', header: 'Observations', cell: (s) => s.observationCount },
    { key: 'actions', header: 'Actions', cell: (s) => (canEdit ? <Button size="sm" variant="secondary" onClick={() => open(s)}>Edit</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Field label="Filter" className="w-full sm:max-w-xs">
          {({ id }) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, slug or publisher" />}
        </Field>
        {canEdit ? <Button onClick={() => open('new')}>Add source</Button> : null}
      </div>
      <DataTable columns={columns} rows={filtered} rowKey={(s) => s.id} rowLabel={(s) => s.title} caption="Sources" emptyMessage="No sources." />
      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'Register a source' : `Edit ${editing?.title ?? ''}`} size="lg">
          <div className="space-y-4">
            {error ? <Alert tone="danger" title="Could not save">{error}</Alert> : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {editing === 'new' ? (
                <Field label="Slug" required hint="Stable id used by imports, e.g. npc-q3-2026.">
                  {({ id }) => <Input id={id} value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />}
                </Field>
              ) : null}
              <Field label="Title" required>
                {({ id }) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />}
              </Field>
              <Field label="Publisher">
                {({ id }) => <Input id={id} value={form.publisher} onChange={(e) => setForm((f) => ({ ...f, publisher: e.target.value }))} />}
              </Field>
              <Field label="URL">
                {({ id }) => <Input id={id} type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />}
              </Field>
              <Field label="Data URL">
                {({ id }) => <Input id={id} type="url" value={form.dataUrl} onChange={(e) => setForm((f) => ({ ...f, dataUrl: e.target.value }))} />}
              </Field>
              <Field label="License rights">
                {({ id }) => (
                  <NativeSelect id={id} value={form.licenseRights} onChange={(e) => setForm((f) => ({ ...f, licenseRights: e.target.value as FormState['licenseRights'] }))}>
                    {RIGHTS.map((r) => (
                      <option key={r} value={r}>{humanize(r)}</option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Retrieved on">
                {({ id }) => <Input id={id} type="date" value={form.retrievedAt} onChange={(e) => setForm((f) => ({ ...f, retrievedAt: e.target.value }))} />}
              </Field>
            </div>
            <Field label="License note">
              {({ id }) => <Textarea id={id} className="min-h-20" value={form.licenseNote} onChange={(e) => setForm((f) => ({ ...f, licenseNote: e.target.value }))} />}
            </Field>
            <Field label="Permitted use" hint="What may be done with the data (e.g. attributed factual reference, no bulk ingestion).">
              {({ id }) => <Textarea id={id} className="min-h-20" value={form.useNote} onChange={(e) => setForm((f) => ({ ...f, useNote: e.target.value }))} />}
            </Field>
            {editing !== 'new' ? (
              <Field label="Change reason" required>
                {({ id }) => <Input id={id} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />}
              </Field>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
              <Button onClick={save} loading={busy} loadingLabel="Saving" disabled={form.title.trim().length < 2 || (editing === 'new' && !form.slug.trim())}>Save</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

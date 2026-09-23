'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, DataTable, Field, Input, useToast, type Column } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { FreshnessPolicyDto } from '@/server/admin/market-data/policies';
import { ActionDialog } from '../../_components/action-dialog';
import { fmtDate } from '../../_components/bits';
import { humanize } from '../_lib/params';

export function FreshnessEditor({ items, canManage }: { items: FreshnessPolicyDto[]; canManage: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<FreshnessPolicyDto | 'new' | null>(null);
  const [dataType, setDataType] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [respect, setRespect] = useState(true);
  const [note, setNote] = useState('');

  function open(p: FreshnessPolicyDto | 'new') {
    setEditing(p);
    setDataType(p === 'new' ? '' : p.dataType);
    setMaxAge(p === 'new' || p.maxAgeDays === null ? '' : String(p.maxAgeDays));
    setRespect(p === 'new' ? true : p.respectSourceValidity);
    setNote(p === 'new' ? '' : (p.note ?? ''));
  }

  async function save(reason: string) {
    const type = editing === 'new' ? dataType.trim() : editing!.dataType;
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(type)) throw new Error('Data type must be snake_case (e.g. rent_observation).');
    await apiFetch(`/api/v1/admin/freshness-policies/${type}`, {
      method: 'PUT',
      body: { maxAgeDays: maxAge.trim() === '' ? null : Number(maxAge), respectSourceValidity: respect, note: note || null, reason, expectedUpdatedAt: editing !== 'new' ? editing?.updatedAt : undefined },
    });
    toast({ title: `Freshness policy ${type} saved`, tone: 'success' });
    router.refresh();
  }

  const columns: Column<FreshnessPolicyDto>[] = [
    { key: 'type', header: 'Data type', cell: (p) => <span className="font-medium">{humanize(p.dataType)}<span className="block font-mono text-xs text-fg-muted">{p.dataType}</span></span> },
    { key: 'age', header: 'Max age', cell: (p) => (p.maxAgeDays === null ? 'Source validity only' : `${p.maxAgeDays} days`) },
    { key: 'respect', header: 'Respect source validity', cell: (p) => (p.respectSourceValidity ? 'Yes' : 'No') },
    { key: 'note', header: 'Note', cell: (p) => <span className="text-xs text-fg-muted">{p.note ?? '—'}</span> },
    { key: 'updated', header: 'Updated', hideOnMobile: true, cell: (p) => <span className="text-xs">{fmtDate(p.updatedAt)}</span> },
    { key: 'actions', header: 'Actions', cell: (p) => (canManage ? <Button size="sm" variant="secondary" onClick={() => open(p)}>Edit</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      {canManage ? <div className="flex justify-end"><Button onClick={() => open('new')}>Add data type</Button></div> : null}
      <DataTable columns={columns} rows={items} rowKey={(p) => p.id} rowLabel={(p) => p.dataType} caption="Freshness policies" />
      <ActionDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add freshness policy' : `Edit ${editing?.dataType ?? ''}`} confirmLabel="Save" requireReason onConfirm={save}>
        {editing === 'new' ? (
          <Field label="Data type (snake_case)" required>
            {({ id }) => <Input id={id} value={dataType} onChange={(e) => setDataType(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Maximum age in days" hint="Leave empty when only the source's own validity applies (official risk layers).">
          {({ id }) => <Input id={id} type="number" min={1} max={3650} value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--sx-primary)]" checked={respect} onChange={(e) => setRespect(e.target.checked)} />
          Respect the source&apos;s declared validity when present
        </label>
        <Field label="Note">
          {({ id }) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </ActionDialog>
    </div>
  );
}

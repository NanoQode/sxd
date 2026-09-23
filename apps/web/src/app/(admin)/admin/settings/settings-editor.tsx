'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  DataTable,
  Field,
  Input,
  NativeSelect,
  Switch,
  Textarea,
  useToast,
  type Column,
} from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { SettingDto } from '@/server/admin/platform/settings';
import { ActionDialog } from '../_components/action-dialog';
import { fmtDate } from '../_components/bits';

export function SettingsEditor({ items, canEdit }: { items: SettingDto[]; canEdit: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<SettingDto | null>(null);
  const [text, setText] = useState('');
  const [bool, setBool] = useState(false);
  const [range, setRange] = useState({ start: '', end: '' });

  function open(s: SettingDto) {
    setEditing(s);
    if (s.type === 'boolean') setBool(Boolean(s.value));
    else if (s.type === 'string_list')
      setText(Array.isArray(s.value) ? (s.value as string[]).join('\n') : '');
    else if (s.type === 'time_range')
      setRange((s.value as { start: string; end: string }) ?? { start: '', end: '' });
    else setText(s.value === null ? '' : String(s.value));
  }

  function valueFor(s: SettingDto): unknown {
    switch (s.type) {
      case 'boolean':
        return bool;
      case 'integer':
        return Number.parseInt(text, 10);
      case 'number':
        return Number(text);
      case 'string_list':
        return text
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
      case 'time_range':
        return range;
      default:
        return text;
    }
  }

  async function save(reason: string) {
    if (!editing) return;
    await apiFetch(`/api/v1/admin/settings/${editing.key}`, {
      method: 'PATCH',
      body: {
        value: valueFor(editing),
        reason: reason || undefined,
        expectedUpdatedAt: editing.updatedAt ?? undefined,
      },
    });
    toast({ title: `${editing.key} saved`, tone: 'success' });
    router.refresh();
  }

  const show = (v: unknown) =>
    Array.isArray(v)
      ? `${v.length} entries`
      : typeof v === 'object' && v !== null
        ? JSON.stringify(v)
        : String(v);
  const columns: Column<SettingDto>[] = [
    {
      key: 'key',
      header: 'Setting',
      cell: (s) => (
        <span>
          <code className="font-mono text-xs">{s.key}</code>
          <span className="block text-xs text-fg-muted">{s.description}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (s) => s.type },
    {
      key: 'value',
      header: 'Value',
      cell: (s) => <span className="break-all text-sm">{show(s.value)}</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      hideOnMobile: true,
      cell: (s) => (
        <span className="text-xs">{s.updatedAt ? fmtDate(s.updatedAt) : 'seeded default'}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (s) =>
        canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => open(s)}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {!canEdit ? (
        <Alert tone="warning">Editing settings requires a verified authenticator.</Alert>
      ) : null}
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(s) => s.key}
        rowLabel={(s) => s.key}
        caption="Platform settings"
      />
      <ActionDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing ? `Edit ${editing.key}` : ''}
        description={editing?.description}
        confirmLabel="Save"
        requireReason
        onConfirm={save}
      >
        {editing?.type === 'boolean' ? (
          <div className="flex items-center gap-3">
            <Switch checked={bool} onCheckedChange={setBool} label={editing.key} />
            <span className="text-sm">{bool ? 'On' : 'Off'}</span>
          </div>
        ) : editing?.type === 'enum' ? (
          <Field label="Value">
            {({ id }) => (
              <NativeSelect id={id} value={text} onChange={(e) => setText(e.target.value)}>
                {editing.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : editing?.type === 'string_list' ? (
          <Field label="One entry per line">
            {({ id }) => (
              <Textarea
                id={id}
                className="min-h-40 font-mono text-xs"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
        ) : editing?.type === 'time_range' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start (HH:MM)">
              {({ id }) => (
                <Input
                  id={id}
                  value={range.start}
                  onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                />
              )}
            </Field>
            <Field label="End (HH:MM)">
              {({ id }) => (
                <Input
                  id={id}
                  value={range.end}
                  onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                />
              )}
            </Field>
          </div>
        ) : editing ? (
          <Field
            label="Value"
            hint={
              editing.min !== undefined || editing.max !== undefined
                ? `Range ${editing.min ?? '…'} – ${editing.max ?? '…'}`
                : undefined
            }
          >
            {({ id }) => (
              <Input
                id={id}
                type={editing.type === 'integer' || editing.type === 'number' ? 'number' : 'text'}
                step={editing.type === 'number' ? 'any' : undefined}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
        ) : null}
      </ActionDialog>
    </div>
  );
}

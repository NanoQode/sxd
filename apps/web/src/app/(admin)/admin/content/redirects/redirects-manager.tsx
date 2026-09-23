'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RedirectDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Field,
  Input,
  NativeSelect,
  Switch,
  formatDateTimeLabel,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

export function RedirectsManager({
  initial,
  canManage,
}: {
  initial: RedirectDto[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [fromPath, setFromPath] = useState('');
  const [toPath, setToPath] = useState('');
  const [statusCode, setStatusCode] = useState<'301' | '302' | '308'>('301');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy('create');
    setError(null);
    try {
      await apiFetch('/api/v1/admin/redirects', {
        method: 'POST',
        body: {
          fromPath: fromPath.trim(),
          toPath: toPath.trim(),
          statusCode: Number(statusCode),
          active: true,
          note: note.trim() || undefined,
        },
      });
      setFromPath('');
      setToPath('');
      setNote('');
      toast({ title: 'Redirect created', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(r: RedirectDto, active: boolean) {
    setBusy(r.id);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/redirects/${r.id}`, { method: 'PATCH', body: { active } });
      toast({ title: active ? 'Redirect enabled' : 'Redirect disabled', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error}
        </Alert>
      ) : null}
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a redirect</CardTitle>
            <CardDescription>
              From an old path to a new relative path or https URL. Loops and API paths are
              rejected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_1fr_auto] lg:items-end"
            >
              <Field label="From path" required hint="e.g. /services/monitoring">
                {({ id }) => (
                  <Input
                    id={id}
                    value={fromPath}
                    onChange={(e) => setFromPath(e.target.value)}
                    required
                    pattern="^/.*"
                  />
                )}
              </Field>
              <Field label="To" required hint="e.g. /services/construction-monitoring">
                {({ id }) => (
                  <Input
                    id={id}
                    value={toPath}
                    onChange={(e) => setToPath(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Status">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={statusCode}
                    onChange={(e) => setStatusCode(e.target.value as '301' | '302' | '308')}
                  >
                    <option value="301">301 permanent</option>
                    <option value="308">308 permanent (method preserved)</option>
                    <option value="302">302 temporary</option>
                  </NativeSelect>
                )}
              </Field>
              <Field label="Note">
                {({ id }) => (
                  <Input
                    id={id}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                  />
                )}
              </Field>
              <Button type="submit" loading={busy === 'create'} loadingLabel="Creating">
                Add
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Alert tone="info">
          You can view redirects; creating and toggling them needs content.publish.
        </Alert>
      )}
      <DataTable
        caption="Redirects"
        rows={initial}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.fromPath} to ${r.toPath}`}
        emptyMessage="No redirects yet. Add them as the site inventory is migrated."
        columns={[
          {
            key: 'from',
            header: 'From',
            cell: (r) => <span className="font-mono text-xs">{r.fromPath}</span>,
          },
          {
            key: 'to',
            header: 'To',
            cell: (r) => <span className="font-mono text-xs">{r.toPath}</span>,
          },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => <Badge tone="neutral">{r.statusCode}</Badge>,
          },
          { key: 'hits', header: 'Hits', cell: (r) => String(r.hitCount), hideOnMobile: true },
          { key: 'note', header: 'Note', cell: (r) => r.note ?? '—', hideOnMobile: true },
          {
            key: 'updated',
            header: 'Updated',
            cell: (r) => formatDateTimeLabel(r.updatedAt),
            hideOnMobile: true,
          },
          {
            key: 'active',
            header: 'Active',
            cell: (r) => (
              <span className="flex items-center gap-2">
                <Switch
                  checked={r.active}
                  disabled={!canManage || busy === r.id}
                  label={`Redirect ${r.fromPath} active`}
                  onCheckedChange={(v) => void toggle(r, v)}
                />
                <span className="text-xs">{r.active ? 'On' : 'Off'}</span>
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

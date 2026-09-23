'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ImportDto } from '@simplexd/contracts';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, Field, NativeSelect, useToast, type Column } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { ActionDialog } from '../../_components/action-dialog';
import { JsonBlock, fmtDate } from '../../_components/bits';

type Format = 'seed_json' | 'observations_csv';

export function ImportsManager({ items, csvColumns }: { items: ImportDto[]; csvColumns: string[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<Format>('seed_json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportDto | null>(null);
  const [applying, setApplying] = useState<ImportDto | null>(null);

  async function runPreview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const content = await file.text();
      const res = await apiFetch<ImportDto>('/api/v1/admin/market-imports/preview', { body: { fileName: file.name, format, content } });
      setPreview(res);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply(reason: string) {
    if (!applying) return;
    const res = await apiFetch<ImportDto>(`/api/v1/admin/market-imports/${applying.id}/apply`, { method: 'POST', body: { reason: reason || undefined } });
    toast({ title: 'Import applied', description: `${res.conflicts.length} conflict(s) reported`, tone: 'success' });
    setPreview(res);
    router.refresh();
  }

  const columns: Column<ImportDto>[] = [
    { key: 'file', header: 'File', cell: (i) => <span className="font-medium">{i.fileName}<span className="block text-xs text-fg-muted">{i.format} · {i.uploadedByName ?? i.uploadedBy ?? '—'}</span></span> },
    { key: 'status', header: 'Status', cell: (i) => <Badge tone={i.status === 'applied' ? 'success' : i.status === 'failed' ? 'danger' : 'neutral'}>{i.status}</Badge> },
    { key: 'errors', header: 'Errors / conflicts', cell: (i) => `${i.rowErrors.length} / ${i.conflicts.length}` },
    { key: 'created', header: 'Previewed', cell: (i) => <span className="text-xs">{fmtDate(i.createdAt)}</span> },
    { key: 'applied', header: 'Applied', cell: (i) => <span className="text-xs">{fmtDate(i.appliedAt)}</span> },
    { key: 'actions', header: 'Actions', cell: (i) => (
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setPreview(i)}>Details</Button>
        {i.status === 'previewed' && i.rowErrors.length === 0 ? <Button size="sm" onClick={() => setApplying(i)}>Apply</Button> : null}
      </div>
    ) },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Preview a file</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert tone="danger" title="Preview failed">{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Format">
              {({ id }) => (
                <NativeSelect id={id} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                  <option value="seed_json">Research seed (JSON, schema 1.0.0)</option>
                  <option value="observations_csv">Observations (CSV)</option>
                </NativeSelect>
              )}
            </Field>
            <Field label="File" className="sm:col-span-2">
              {({ id }) => (
                <input
                  id={id}
                  type="file"
                  accept={format === 'seed_json' ? '.json,application/json' : '.csv,text/csv'}
                  className="block h-11 w-full text-sm file:mr-3 file:h-11 file:rounded-md file:border file:border-border-strong file:bg-bg-elevated file:px-3"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setFile(f);
                    if (f?.name.toLowerCase().endsWith('.csv')) setFormat('observations_csv');
                    if (f?.name.toLowerCase().endsWith('.json')) setFormat('seed_json');
                  }}
                />
              )}
            </Field>
          </div>
          <Button onClick={runPreview} disabled={!file} loading={busy} loadingLabel="Previewing">Preview (dry run)</Button>
          {format === 'observations_csv' ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-primary">CSV columns</summary>
              <p className="mt-1 text-fg-muted">Header names match the observation contract. <code>sourceSlug</code>, <code>marketSlug</code> and <code>stateName</code> resolve ids; a <code>slug</code> column makes re-imports skip existing rows.</p>
              <code className="mt-1 block break-all rounded bg-bg-sunken p-2 font-mono text-xs">{csvColumns.join(',')}</code>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {preview ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{preview.fileName} <Badge tone={preview.status === 'applied' ? 'success' : preview.status === 'failed' ? 'danger' : 'neutral'}>{preview.status}</Badge></CardTitle>
              {preview.status === 'previewed' && preview.rowErrors.length === 0 ? <Button onClick={() => setApplying(preview)}>Apply this import</Button> : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {preview.rowErrors.length > 0 ? (
              <Alert tone="danger" title={`${preview.rowErrors.length} row-level error(s); fix the file and preview again`}>
                <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5">
                  {preview.rowErrors.map((e, i) => (
                    <li key={i}>{e.row !== null ? `Row ${e.row}: ` : ''}<code>{e.path}</code> {e.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {preview.conflicts.length > 0 ? (
              <Alert tone="warning" title={`${preview.conflicts.length} conflict(s): human-edited records are not overwritten`}>
                <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5">
                  {preview.conflicts.map((c, i) => (
                    <li key={i}><code>{c.entity} {c.id}</code>: {c.reason}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <div>
              <p className="font-medium">Summary</p>
              <JsonBlock value={preview.summary} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">History</h2>
        <DataTable columns={columns} rows={items} rowKey={(i) => i.id} rowLabel={(i) => i.fileName} caption="Import history" emptyMessage="No imports yet." />
      </section>

      <ActionDialog
        open={applying !== null}
        onOpenChange={(o) => !o && setApplying(null)}
        title={`Apply ${applying?.fileName ?? ''}`}
        description="Writes the previewed records. Existing human-edited records are skipped and reported; imported markets stay drafts and observations await review."
        confirmLabel="Apply import"
        requireReason
        onConfirm={apply}
      />
    </div>
  );
}

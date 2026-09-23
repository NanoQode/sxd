'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { RedirectDto, RedirectImportResult, RedirectImportRow } from '@simplexd/contracts';
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
  Textarea,
  formatDateTimeLabel,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

const CSV_EXAMPLE = `path,target,status
/services/monitoring,/services/construction-monitoring,301
https://simplexd.co/old-page.html,/about,301`;

function outcomeTone(outcome: RedirectImportRow['outcome']) {
  switch (outcome) {
    case 'create':
      return 'info' as const;
    case 'created':
      return 'success' as const;
    case 'unchanged':
      return 'neutral' as const;
    case 'skip':
      return 'neutral' as const;
    case 'error':
      return 'danger' as const;
  }
}

/**
 * Bulk import: paste or choose a `path,target,status` CSV, preview every row
 * (dry run, nothing written), then import the rows that validated. Rows that
 * failed are listed with the reason and left out; nothing is written per row
 * until the import step.
 */
function CsvImport({ onImported }: { onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<RedirectImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'import');
    setError(null);
    try {
      const result = await apiFetch<RedirectImportResult>('/api/v1/admin/redirects/import', {
        method: 'POST',
        body: { csv, dryRun },
      });
      setPreview(result);
      if (!dryRun) onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(typeof reader.result === 'string' ? reader.result : '');
      setPreview(null);
    };
    reader.onerror = () => setError('The file could not be read.');
    reader.readAsText(file);
  }

  const rows = preview?.rows ?? [];
  const summary = preview?.summary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk import (CSV)</CardTitle>
        <CardDescription>
          Columns <code className="font-mono text-xs">path,target,status</code> (status 301, 302
          or 308; default 301). The site inventory&apos;s{' '}
          <code className="font-mono text-xs">source_url,target_url,decision</code> columns are
          accepted too: only rows whose decision is <em>redirect</em> are imported. Preview first;
          nothing is written until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="CSV" hint="Paste the rows or choose a file below.">
          {({ id }) => (
            <Textarea
              id={id}
              rows={6}
              className="font-mono text-xs"
              placeholder={CSV_EXAMPLE}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview(null);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label="Choose a CSV file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            Choose CSV file
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void run(true)}
            loading={busy === 'preview'}
            loadingLabel="Checking"
            disabled={!csv.trim() || busy !== null}
          >
            Preview (dry run)
          </Button>
          <Button
            size="sm"
            onClick={() => void run(false)}
            loading={busy === 'import'}
            loadingLabel="Importing"
            disabled={!preview || preview.dryRun === false || !summary || summary.create === 0}
            title={
              !preview
                ? 'Preview first'
                : summary && summary.create === 0
                  ? 'No valid new rows to import'
                  : undefined
            }
          >
            Import {summary?.create ?? 0} valid row{summary?.create === 1 ? '' : 's'}
          </Button>
        </div>
        {error ? (
          <Alert tone="danger" title="Import failed">
            {error}
          </Alert>
        ) : null}
        {preview && summary ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted" role="status">
              {preview.dryRun ? 'Dry run: nothing was written.' : 'Import applied.'}{' '}
              {summary.total} row{summary.total === 1 ? '' : 's'}:{' '}
              {preview.dryRun ? `${summary.create} to create` : `${summary.created} created`},{' '}
              {summary.unchanged} unchanged, {summary.skip} skipped, {summary.error} with errors.
            </p>
            <DataTable
              caption="Import preview"
              rows={rows}
              rowKey={(r) => String(r.line)}
              rowLabel={(r) => `line ${r.line}`}
              emptyMessage="No rows."
              columns={[
                { key: 'line', header: 'Line', cell: (r) => String(r.line), hideOnMobile: true },
                {
                  key: 'from',
                  header: 'From',
                  cell: (r) => <span className="font-mono text-xs">{r.fromPath || '—'}</span>,
                },
                {
                  key: 'to',
                  header: 'To',
                  cell: (r) => <span className="font-mono text-xs">{r.toPath || '—'}</span>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (r) => String(r.statusCode),
                  hideOnMobile: true,
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (r) => (
                    <span className="flex flex-col gap-1">
                      <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
                      {r.reason ? <span className="text-xs text-fg-muted">{r.reason}</span> : null}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

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
              From an old path to a new relative path or https URL. Loops, API and private paths,
              and paths that are currently live pages are rejected: redirects only apply where the
              site would otherwise answer 404.
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
      {canManage ? (
        <CsvImport
          onImported={() => {
            toast({ title: 'Redirects imported', tone: 'success' });
            router.refresh();
          }}
        />
      ) : null}
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

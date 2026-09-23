'use client';

import { useState } from 'react';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Triggers the rent job and shows its raw per-lease outcome. */
export function RentRunForm() {
  const [asOf, setAsOf] = useState('');
  const [leadDays, setLeadDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await adminFetch<Record<string, unknown>>('/api/v1/rent/invoicing-runs', {
          body: { asOf: asOf || undefined, leadDays: leadDays ? Number(leadDays) : undefined },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const summary = result
    ? Object.entries(result)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(v)}`)
        .join(' · ')
    : '';
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
        <Field label="As of (default today)">
          {({ id }) => (
            <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          )}
        </Field>
        <Field label="Lead days (default 14)">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={90}
              value={leadDays}
              onChange={(e) => setLeadDays(e.target.value)}
            />
          )}
        </Field>
        <Button loading={busy} onClick={() => void run()}>
          Run rent invoicing
        </Button>
      </div>
      {error ? (
        <Alert tone="danger" title="Run failed">
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Alert tone="success" title="Run finished">
          {summary || 'Completed.'}
          <details className="mt-2">
            <summary className="cursor-pointer">Full result</summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg-sunken p-2 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </Alert>
      ) : null}
    </div>
  );
}

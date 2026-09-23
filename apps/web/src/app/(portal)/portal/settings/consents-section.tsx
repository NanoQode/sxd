'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ConsentDto } from '@simplexd/contracts';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, Switch, formatDateTimeLabel, humanize, useToast } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

export function ConsentsSection({ consents, marketingGranted, timeZone }: { consents: ConsentDto[]; marketingGranted: boolean; timeZone: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [granted, setGranted] = useState(marketingGranted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/v1/me/consents', { method: 'POST', body: { purpose: 'marketing_email', granted: next, source: 'portal_settings' } });
      setGranted(next);
      toast({ title: next ? 'Marketing emails enabled' : 'Marketing emails disabled', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacy and marketing</CardTitle>
        <CardDescription>
          Every consent decision is recorded with its policy version and source; the history below is append-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert tone="danger" title="Could not record consent">
            {error}
          </Alert>
        ) : null}
        <div className="flex items-center gap-3 rounded-md border border-border p-3">
          <Switch checked={granted} onCheckedChange={(v) => void toggle(v)} disabled={busy} id="marketing-consent" label="Marketing emails" />
          <label htmlFor="marketing-consent" className="text-sm">
            <span className="font-medium">Marketing emails</span>
            <br />
            <span className="text-fg-muted">Product news and offers. Transactional and security messages are unaffected.</span>
          </label>
        </div>
        <DataTable
          caption="Consent history"
          rows={consents}
          rowKey={(c) => c.id}
          rowLabel={(c) => `${humanize(c.purpose)} ${c.granted ? 'granted' : 'withdrawn'}`}
          emptyMessage="No consent decisions recorded yet."
          columns={[
            { key: 'purpose', header: 'Purpose', cell: (c) => humanize(c.purpose) },
            { key: 'decision', header: 'Decision', cell: (c) => (c.granted ? <Badge tone="success">Granted</Badge> : <Badge tone="neutral">Withdrawn</Badge>) },
            { key: 'policy', header: 'Policy version', cell: (c) => c.policyVersion, hideOnMobile: true },
            { key: 'source', header: 'Source', cell: (c) => humanize(c.source), hideOnMobile: true },
            { key: 'when', header: 'Recorded', cell: (c) => formatDateTimeLabel(c.recordedAt, timeZone) },
          ]}
        />
      </CardContent>
    </Card>
  );
}

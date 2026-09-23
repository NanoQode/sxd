'use client';

import { useState } from 'react';
import type { TestBookingResult } from '@simplexd/contracts';
import { Alert, Button, formatDateTimeLabel } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Creates and deletes a real event through the calendar provider and reports exactly what happened. */
export function TestBookingButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestBookingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await adminFetch<TestBookingResult>('/api/v1/admin/calendar/test-booking', { body: {} }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void run()}>
        Run test booking
      </Button>
      {error ? (
        <Alert tone="danger" title="Test booking failed">
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Alert tone={result.ok ? 'success' : 'danger'} title={result.ok ? `Test booking succeeded (${result.adapter} adapter)` : `Test booking failed (${result.adapter} adapter)`}>
          {result.message} Conference: {result.conferenceStatus}
          {result.meetUrl ? ' · Meet link created' : ''}. Event {result.deleted ? 'deleted again' : 'NOT deleted, remove it manually'}. Checked {formatDateTimeLabel(result.checkedAt)}.
          {result.adapter === 'dev' ? ' The development adapter does not contact Google.' : ''}
        </Alert>
      ) : null}
    </div>
  );
}

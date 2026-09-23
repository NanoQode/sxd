'use client';

import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

interface DeletionResult {
  leadId: string;
  alreadyRequested: boolean;
  retentionPolicy: string;
}

export function DangerZone({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeletionResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<DeletionResult>('/api/v1/me/account-deletion', {
        method: 'POST',
        body: { confirmEmail: confirmEmail.trim(), reason: reason.trim() || undefined },
      });
      setResult(res);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle>Request account deletion</CardTitle>
        <CardDescription>
          Deletion is handled by support, not instantly: accounting, contractual and legal records
          linked to engagements must be retained for the statutory period; everything else is
          deleted or anonymised. You receive a written outcome.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result ? (
          <Alert
            tone={result.alreadyRequested ? 'info' : 'success'}
            title={
              result.alreadyRequested
                ? 'A deletion request is already open'
                : 'Deletion request recorded'
            }
          >
            Support ticket {result.leadId.slice(0, 8)}. {result.retentionPolicy}
          </Alert>
        ) : (
          <Button variant="danger" onClick={() => setOpen(true)}>
            Request deletion
          </Button>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            title="Confirm deletion request"
            description="Type your account email to confirm. Support will contact you before anything is removed."
            size="sm"
          >
            <div className="space-y-3">
              {error ? (
                <Alert tone="danger" title="Could not submit">
                  {error}
                </Alert>
              ) : null}
              <Field label={`Your email (${email})`} required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="off"
                    value={confirmEmail}
                    onChange={(e) => setConfirmEmail(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Reason (optional)">
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                )}
              </Field>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                  Keep my account
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void submit()}
                  loading={busy}
                  loadingLabel="Submitting"
                  disabled={confirmEmail.trim().length === 0}
                >
                  Submit request
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

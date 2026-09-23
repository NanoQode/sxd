'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

export function TwoFactorForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
        : await authClient.twoFactor.verifyBackupCode({ code });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? 'That code was not accepted.');
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error ? (
        <Alert tone="danger" title="Verification failed">
          {error}
        </Alert>
      ) : null}
      <Field label={mode === 'totp' ? 'Authenticator code' : 'Backup code'} required>
        {({ id, describedBy }) => (
          <Input
            id={id}
            inputMode={mode === 'totp' ? 'numeric' : 'text'}
            autoComplete="one-time-code"
            pattern={mode === 'totp' ? '[0-9]{6}' : undefined}
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
            aria-describedby={describedBy}
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={busy} loadingLabel="Verifying">
        Verify
      </Button>
      <Button
        type="button"
        variant="link"
        className="w-full"
        onClick={() => setMode(mode === 'totp' ? 'backup' : 'totp')}
      >
        {mode === 'totp' ? 'Use a backup code instead' : 'Use your authenticator app instead'}
      </Button>
    </form>
  );
}

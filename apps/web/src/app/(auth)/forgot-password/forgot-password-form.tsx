'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
    setBusy(false);
    setDone(true);
  }

  if (done) {
    return (
      <Alert tone="success" title="Check your email">
        If an account exists for {email}, a reset link is on its way. It expires in one hour.
      </Alert>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email" required>
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={describedBy}
            required
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={busy} loadingLabel="Sending">
        Send reset link
      </Button>
    </form>
  );
}

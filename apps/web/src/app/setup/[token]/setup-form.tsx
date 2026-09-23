'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

export function SetupAdminForm({
  token,
  email,
  signedInEmail,
}: {
  token: string;
  email: string;
  signedInEmail: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alreadySignedInAsTarget = signedInEmail?.toLowerCase() === email.toLowerCase();

  async function complete(): Promise<void> {
    const res = await fetch('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? 'Setup could not be completed.');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!alreadySignedInAsTarget) {
      if (name.trim().length < 2) return setError('Enter your name.');
      if (password.length < 12) return setError('Use at least 12 characters.');
    }
    setBusy(true);
    try {
      if (!alreadySignedInAsTarget) {
        const res = await authClient.signUp.email({ name: name.trim(), email, password });
        if (res.error) throw new Error(res.error.message ?? 'Could not create the account.');
        const session = await authClient.getSession();
        if (!session.data?.session) {
          const signIn = await authClient.signIn.email({ email, password });
          if (signIn.error) throw new Error(signIn.error.message ?? 'Could not sign in.');
        }
      }
      await complete();
      router.push('/admin/security/mfa?required=1&welcome=1');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error ? (
        <Alert tone="danger" title="Setup failed">
          {error}
        </Alert>
      ) : null}
      <Field label="Administrator email">
        {({ id }) => <Input id={id} value={email} readOnly aria-readonly />}
      </Field>
      {!alreadySignedInAsTarget ? (
        <>
          <Field label="Your name" required>
            {({ id }) => (
              <Input
                id={id}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Password"
            required
            hint="At least 12 characters. You will enrol an authenticator app next; it is required for administrators."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </>
      ) : (
        <Alert tone="info">
          You are signed in as {signedInEmail}. Continue to grant administrator access to this
          account.
        </Alert>
      )}
      <Button type="submit" className="w-full" loading={busy} loadingLabel="Setting up">
        {alreadySignedInAsTarget ? 'Grant administrator access' : 'Create administrator account'}
      </Button>
    </form>
  );
}

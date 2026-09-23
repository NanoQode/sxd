'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  StatusBadge,
  useToast,
} from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

type Step = 'idle' | 'enrolling' | 'verify' | 'done';

/**
 * Enrol, verify and disable TOTP with better-auth's two-factor plugin. The
 * secret is shown once as a QR code plus backup codes; verification of a
 * first code completes enrolment.
 */
export function MfaManager({ enabled, email }: { enabled: boolean; email: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.enable({ password });
      if (res.error) throw new Error(res.error.message ?? 'Could not start enrolment.');
      const data = res.data as { totpURI: string; backupCodes: string[] };
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes);
      setQr(await QRCode.toDataURL(data.totpURI, { margin: 1, width: 220 }));
      setPassword('');
      setStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start enrolment.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice: false });
      if (res.error) throw new Error(res.error.message ?? 'That code was not accepted.');
      setStep('done');
      toast({ title: 'Authenticator verified', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.disable({ password });
      if (res.error) throw new Error(res.error.message ?? 'Could not disable the authenticator.');
      setPassword('');
      toast({ title: 'Authenticator disabled', description: 'Sensitive actions are locked until you enrol again.' });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable the authenticator.');
    } finally {
      setBusy(false);
    }
  }

  const secret = totpUri ? new URL(totpUri).searchParams.get('secret') : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Status</CardTitle>
              <CardDescription>{email}</CardDescription>
            </div>
            <StatusBadge status={enabled ? 'verified' : 'disabled'} label={enabled ? 'Authenticator verified' : 'Not enrolled'} />
          </div>
        </CardHeader>
      </Card>

      {error ? (
        <Alert tone="danger" title="Something went wrong">
          {error}
        </Alert>
      ) : null}

      {!enabled && step !== 'verify' && step !== 'done' ? (
        <Card>
          <CardHeader>
            <CardTitle>Enrol an authenticator app</CardTitle>
            <CardDescription>
              Confirm your password to generate a secret for apps such as Aegis, 1Password, Google
              Authenticator or Microsoft Authenticator.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={enable} className="space-y-4">
              <Field label="Current password" required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" loading={busy} loadingLabel="Generating">
                Generate secret
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {step === 'verify' ? (
        <Card>
          <CardHeader>
            <CardTitle>Scan, then verify a code</CardTitle>
            <CardDescription>
              Scan the QR code or enter the secret manually, then type the six-digit code your app
              shows to finish enrolment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col items-start gap-4 sm:flex-row">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="QR code for your authenticator app" width={220} height={220} className="rounded-md border border-border bg-white p-1" />
              ) : null}
              <div className="min-w-0 space-y-2 text-sm">
                <p className="text-fg-muted">Manual entry secret:</p>
                <code className="block break-all rounded bg-bg-sunken p-2 font-mono text-xs">{secret ?? totpUri}</code>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium">Backup codes (shown once; store them safely)</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-5">
                {backupCodes.map((c) => (
                  <li key={c} className="rounded bg-bg-sunken px-2 py-1">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <form onSubmit={verify} className="space-y-4">
              <Field label="Six-digit code" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" loading={busy} loadingLabel="Verifying">
                Verify and finish
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {step === 'done' ? (
        <Alert tone="success" title="Enrolment complete">
          Your authenticator is verified. Sensitive actions are now available for this account.
        </Alert>
      ) : null}

      {enabled ? (
        <Card>
          <CardHeader>
            <CardTitle>Disable the authenticator</CardTitle>
            <CardDescription>
              Disabling removes access to publication, policy, role, settings and integration actions
              until you enrol again. This is recorded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={disable} className="space-y-4">
              <Field label="Current password" required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" variant="danger" loading={busy} loadingLabel="Disabling">
                Disable authenticator
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

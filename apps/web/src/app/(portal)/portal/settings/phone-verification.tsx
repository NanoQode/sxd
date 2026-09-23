'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { PhoneVerificationRequestResponse } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

/**
 * Verify the saved phone number with a 6-digit SMS code. Shown only while a
 * number is saved and not yet verified. SMS notifications go only to verified
 * numbers, so this also unlocks the SMS preferences.
 */
export function PhoneVerification({ phoneE164 }: { phoneE164: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [sent, setSent] = useState<PhoneVerificationRequestResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'request' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState<number>(0);

  // Countdown until another code may be requested.
  useEffect(() => {
    if (retryIn <= 0) return;
    const t = setTimeout(() => setRetryIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  async function request() {
    setBusy('request');
    setError(null);
    try {
      const res = await apiFetch<PhoneVerificationRequestResponse>('/api/v1/me/phone/verification', {
        method: 'POST',
        body: {},
      });
      if (res.status === 'already_verified') {
        toast({ title: 'This number is already verified', tone: 'info' });
        router.refresh();
        return;
      }
      setSent(res);
      setCode('');
      if (res.resendAvailableAt) {
        setRetryIn(
          Math.max(0, Math.ceil((new Date(res.resendAvailableAt).getTime() - Date.now()) / 1000)),
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy('confirm');
    setError(null);
    try {
      await apiFetch('/api/v1/me/phone/verification/confirm', {
        method: 'POST',
        body: { code: code.trim() },
      });
      toast({
        title: 'Phone number verified',
        description: 'SMS notifications can now reach this number.',
        tone: 'success',
      });
      setSent(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your phone number</CardTitle>
        <CardDescription>
          We only send SMS to numbers confirmed with a code. Codes expire after 10 minutes and allow
          5 attempts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert tone="danger" title="Verification did not complete">
            {error}
          </Alert>
        ) : null}
        <p className="text-sm">
          Number on file: <span className="font-medium">{phoneE164}</span>{' '}
          <Badge tone="neutral">Unverified</Badge>
        </p>
        {sent ? (
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <Alert
              tone={sent.delivery?.developmentAdapter ? 'warning' : 'info'}
              title={
                sent.delivery?.developmentAdapter
                  ? 'Development adapter — no real message was sent'
                  : `Code sent to ${sent.phoneMasked}`
              }
            >
              {sent.delivery?.developmentAdapter ? (
                <>
                  <p>{sent.delivery.label}</p>
                  {sent.delivery.developmentCode ? (
                    <p className="mt-1">
                      Development code:{' '}
                      <code className="rounded bg-bg-sunken px-1 font-mono">
                        {sent.delivery.developmentCode}
                      </code>{' '}
                      (shown only in development).
                    </p>
                  ) : null}
                </>
              ) : (
                <p>{sent.delivery?.label}</p>
              )}
              {sent.expiresAt ? (
                <p className="mt-1 text-xs">
                  Expires {new Date(sent.expiresAt).toLocaleTimeString()}.
                </p>
              ) : null}
            </Alert>
            <Field label="6-digit code" required hint="Never share this code with anyone.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="max-w-[10rem] font-mono text-lg tracking-widest"
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={code.length !== 6 || busy !== null}
                loading={busy === 'confirm'}
                loadingLabel="Checking"
              >
                Confirm code
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy !== null || retryIn > 0}
                loading={busy === 'request'}
                loadingLabel="Sending"
                onClick={request}
              >
                {retryIn > 0 ? `Resend in ${retryIn}s` : 'Send a new code'}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            onClick={request}
            disabled={busy !== null}
            loading={busy === 'request'}
            loadingLabel="Sending"
          >
            Send verification code
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

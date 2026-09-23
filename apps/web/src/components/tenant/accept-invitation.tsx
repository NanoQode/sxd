'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { LeasePartyDto } from '@simplexd/contracts';
import { Alert, Button } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';
import { describeTenantError, tenantFetch } from '@/lib/tenant/client';
import {
  INVITATION_FAILURE_COPY,
  classifyInvitationError,
  type InvitationFailure,
} from '@/lib/tenant/model';

/**
 * Redeems a lease invitation through `POST /api/v1/tenant/invitations/accept`.
 * The server checks the token, its expiry and the signed-in e-mail; every
 * refusal is shown as the state it really is (used or revoked, expired,
 * wrong account) with the next step, never as a generic failure.
 */
export function AcceptTenantInvitation({ token }: { token: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    kind: InvitationFailure;
    message: string;
    correlationId: string | null;
  } | null>(null);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await tenantFetch<LeasePartyDto>('/api/v1/tenant/invitations/accept', { body: { token } });
      queryClient.clear();
      router.push('/tenant?welcome=1');
      router.refresh();
    } catch (err) {
      const e = describeTenantError(err);
      setFailure({
        kind: classifyInvitationError(e.code, e.message),
        message: e.message,
        correlationId: e.correlationId,
      });
      setBusy(false);
    }
  }

  if (failure && failure.kind !== 'error') {
    const copy = INVITATION_FAILURE_COPY[failure.kind];
    return (
      <div className="space-y-3">
        <Alert tone="warning" title={copy.title}>
          <p>{copy.body}</p>
          {failure.correlationId ? (
            <p className="mt-1 text-xs">
              Reference for support: <code className="font-mono">{failure.correlationId}</code>
            </p>
          ) : null}
        </Alert>
        {failure.kind === 'wrong_email' ? <SwitchAccount /> : null}
        {failure.kind === 'conflict' ? (
          <Button type="button" variant="secondary" onClick={() => router.refresh()}>
            Reload the invitation
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {failure ? (
        <Alert tone="danger" title={INVITATION_FAILURE_COPY.error.title}>
          <p>
            {failure.message} {INVITATION_FAILURE_COPY.error.body}
          </p>
          {failure.correlationId ? (
            <p className="mt-1 text-xs">
              Reference for support: <code className="font-mono">{failure.correlationId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}
      <Button
        type="button"
        className="w-full sm:w-auto"
        onClick={() => void accept()}
        loading={busy}
        loadingLabel="Accepting"
      >
        {failure ? 'Try again' : 'Accept invitation'}
      </Button>
    </div>
  );
}

/** Signs out and returns to sign-in with the invitation link as the destination. */
export function SwitchAccount({
  label = 'Sign out and use the invited email',
}: {
  label?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function switchAccount() {
    setBusy(true);
    const next = `${window.location.pathname}${window.location.search}`;
    await authClient.signOut().catch(() => undefined);
    queryClient.clear();
    router.push(`/sign-in?next=${encodeURIComponent(next)}`);
    router.refresh();
  }
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => void switchAccount()}
      loading={busy}
      loadingLabel="Signing out"
    >
      {label}
    </Button>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, formatDateTimeLabel } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

export function AcceptInvitation({ invitationId, organizationName, expiresAt }: { invitationId: string; organizationName: string; expiresAt: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  async function accept() {
    setBusy('accept');
    setError(null);
    const res = await authClient.organization.acceptInvitation({ invitationId });
    if (res.error) {
      setError(res.error.message ?? 'Could not accept the invitation.');
      setBusy(null);
      return;
    }
    queryClient.clear();
    router.push('/portal');
    router.refresh();
  }

  async function reject() {
    setBusy('reject');
    setError(null);
    const res = await authClient.organization.rejectInvitation({ invitationId });
    if (res.error) {
      setError(res.error.message ?? 'Could not decline the invitation.');
      setBusy(null);
      return;
    }
    setDeclined(true);
    setBusy(null);
  }

  if (declined) {
    return (
      <Alert tone="info" title="Invitation declined">
        You will not be added to {organizationName}.
      </Alert>
    );
  }
  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" title="Could not complete">
          {error}
        </Alert>
      ) : null}
      <p className="text-sm text-fg-muted">
        Accepting makes {organizationName} your active organisation. You can switch organisations from the portal header at any time. Expires{' '}
        {formatDateTimeLabel(expiresAt)}.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" onClick={() => void accept()} loading={busy === 'accept'} loadingLabel="Joining" disabled={busy === 'reject'}>
          Accept and join
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => void reject()} loading={busy === 'reject'} loadingLabel="Declining" disabled={busy === 'accept'}>
          Decline
        </Button>
      </div>
    </div>
  );
}

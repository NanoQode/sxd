'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, humanize, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Invite verified partners; unverified ones are listed but flagged so the choice is deliberate. */
export function InvitePartners({
  tenderId,
  partners,
  invitedIds,
}: {
  tenderId: string;
  partners: Array<{ userId: string; name: string; email: string; partnerType: string; verificationStatus: string }>;
  invitedIds: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = partners.filter((p) => !invitedIds.includes(p.userId));

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/tenders/${tenderId}/invitations`, { body: { partnerUserIds: picked } });
      toast({ title: `${picked.length} partner${picked.length === 1 ? '' : 's'} invited`, tone: 'success' });
      setPicked([]);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (available.length === 0) return <p className="text-sm text-fg-muted">Every partner in the directory is already invited.</p>;
  return (
    <div className="space-y-2">
      {error ? (
        <Alert tone="danger" title="Could not invite">
          {error}
        </Alert>
      ) : null}
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Invite partners</legend>
        <div className="max-h-56 space-y-1 overflow-auto rounded-md border border-border p-2">
          {available.map((p) => (
            <label key={p.userId} className="flex min-h-9 flex-wrap items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={picked.includes(p.userId)}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, p.userId] : prev.filter((x) => x !== p.userId)))}
              />
              <span>{p.name}</span>
              <span className="text-xs text-fg-muted">
                {humanize(p.partnerType)} · {p.verificationStatus === 'verified' ? 'verified' : <strong className="text-warning">{humanize(p.verificationStatus)}</strong>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Button size="sm" disabled={picked.length === 0} loading={busy} onClick={() => void invite()}>
        Invite {picked.length || ''}
      </Button>
    </div>
  );
}

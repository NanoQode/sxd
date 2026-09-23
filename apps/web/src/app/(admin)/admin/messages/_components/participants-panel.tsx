'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ConversationParticipantDto } from '@simplexd/contracts';
import { Alert, Badge, Button, Field, NativeSelect, humanize, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** Participants: add staff or organisation members, remove, or join as a reader with messages.read_all. */
export function ParticipantsPanel({
  conversationId,
  participants,
  candidates,
  me,
  amParticipant,
  closed,
}: {
  conversationId: string;
  participants: ConversationParticipantDto[];
  candidates: Array<{ userId: string; name: string; group: string }>;
  me: string;
  amParticipant: boolean;
  closed: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = participants.filter((p) => !p.leftAt);
  const available = candidates.filter((c) => !active.some((p) => p.userId === c.userId));
  const groups = [...new Set(available.map((c) => c.group))];

  async function add(id: string, label: string) {
    setBusy(id);
    setError(null);
    try {
      await adminFetch(`/api/v1/conversations/${conversationId}/participants`, { body: { userId: id } });
      toast({ title: `${label} added`, tone: 'success' });
      setUserId('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string, label: string) {
    setBusy(id);
    setError(null);
    try {
      await adminFetch(`/api/v1/conversations/${conversationId}/participants/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast({ title: id === me ? 'You left the conversation' : `${label} removed`, tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" title="Could not update participants">
          {error}
        </Alert>
      ) : null}
      <ul className="space-y-1">
        {participants.map((p) => (
          <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2">
            <span className={p.leftAt ? 'text-fg-muted line-through' : undefined}>
              {p.name ?? p.userId} <Badge>{humanize(p.role)}</Badge> {p.userId === me ? <Badge tone="primary">you</Badge> : null}
            </span>
            {!p.leftAt && !closed ? (
              <Button size="sm" variant="ghost" loading={busy === p.userId} onClick={() => void remove(p.userId, p.name ?? 'Participant')}>
                {p.userId === me ? 'Leave' : 'Remove'}
              </Button>
            ) : p.leftAt ? (
              <span className="text-xs text-fg-muted">left</span>
            ) : null}
          </li>
        ))}
      </ul>
      {!closed && !amParticipant ? (
        <Button size="sm" loading={busy === me} onClick={() => void add(me, 'You')}>
          Join conversation
        </Button>
      ) : null}
      {!closed && available.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add participant" hint="They must already have access to the linked record or organisation.">
            {({ id, describedBy }) => (
              <NativeSelect id={id} aria-describedby={describedBy} value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose</option>
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {available
                      .filter((c) => c.group === g)
                      .map((c) => (
                        <option key={c.userId} value={c.userId}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button size="sm" variant="secondary" disabled={!userId} loading={busy === userId && Boolean(userId)} onClick={() => void add(userId, available.find((c) => c.userId === userId)?.name ?? 'Participant')}>
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}

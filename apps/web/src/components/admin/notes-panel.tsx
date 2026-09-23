'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { EntityNoteDto, NoteDto, NoteEntityType, Visibility } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Field,
  NativeSelect,
  Textarea,
  formatDateTimeLabel,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

type AnyNote =
  Pick<NoteDto, 'id' | 'body' | 'visibility' | 'authorName' | 'createdAt'> | EntityNoteDto;

const VISIBILITY_HELP: Record<Visibility, string> = {
  internal: 'Staff only. Never shown to the customer or partners.',
  customer: 'Visible to the customer organisation and staff.',
  partner: 'Visible to assigned partners and staff.',
  all: 'Visible to everyone with access to this record.',
};

/** Append-only notes with explicit visibility; posts through /api/v1/notes. */
export function NotesPanel({
  entityType,
  entityId,
  notes,
  canWrite,
  allowedVisibilities = ['internal', 'customer'],
}: {
  entityType: NoteEntityType;
  entityId: string;
  notes: AnyNote[];
  canWrite: boolean;
  allowedVisibilities?: Visibility[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(allowedVisibilities[0] ?? 'internal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch('/api/v1/notes', {
        body: { entityType, entityId, body: body.trim(), visibility },
      });
      setBody('');
      toast({ title: 'Note added', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {notes.length === 0 ? (
        <p className="text-fg-muted">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-bg p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="font-medium text-fg">{n.authorName ?? 'Unknown author'}</span>
                <span>{formatDateTimeLabel(n.createdAt)}</span>
                <Badge tone={n.visibility === 'internal' ? 'warning' : 'info'}>
                  {n.visibility}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <div className="space-y-3 rounded-md border border-dashed border-border p-3">
          {error ? (
            <Alert tone="danger" title="Could not add note">
              {error}
            </Alert>
          ) : null}
          <Field label="New note" required>
            {({ id }) => (
              <Textarea
                id={id}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={8000}
                className="min-h-24"
              />
            )}
          </Field>
          <Field label="Visibility" hint={VISIBILITY_HELP[visibility]}>
            {({ id }) => (
              <NativeSelect
                id={id}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
              >
                {allowedVisibilities.map((v) => (
                  <option key={v} value={v}>
                    {v === 'internal'
                      ? 'Internal (staff only)'
                      : v === 'customer'
                        ? 'Customer-visible'
                        : v}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button
            size="sm"
            loading={busy}
            disabled={body.trim().length === 0}
            onClick={() => void submit()}
          >
            Add note
          </Button>
        </div>
      ) : null}
    </div>
  );
}

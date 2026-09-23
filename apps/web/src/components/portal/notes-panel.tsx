'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import type { EntityNoteDto, NoteEntityType } from '@simplexd/contracts';
import {
  Badge,
  Button,
  Field,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

/** The fields the panel renders; request notes (NoteDto) and entity notes both fit. */
export type PanelNote = Pick<
  EntityNoteDto,
  'id' | 'body' | 'visibility' | 'authorName' | 'createdAt'
>;

/** Visibilities a customer may choose (the API refuses `internal` and `partner` from customers). */
export type CustomerNoteVisibility = 'customer' | 'all';

export const NOTE_VISIBILITY_LABELS: Record<string, string> = {
  customer: 'You and the SimplexD team',
  all: 'Team and assigned specialists',
  partner: 'Assigned specialists',
  internal: 'Staff only',
};

/**
 * Customer-visible notes on any entity (customer/all visibility only; the
 * API never returns internal notes and this form never sends that value).
 * The author chooses who may read a new note: the SimplexD team only
 * (`customer`) or the team plus assigned partners such as inspectors and
 * contractors (`all`).
 */
export function NotesPanel({
  entityType,
  entityId,
  notes,
  zone,
  readOnly = false,
  readOnlyReason,
}: {
  entityType: NoteEntityType;
  entityId: string;
  notes: PanelNote[];
  zone: string;
  readOnly?: boolean;
  readOnlyReason?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const visibilityName = useId();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<CustomerNoteVisibility>('customer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  async function submit() {
    if (body.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await portalFetch('/api/v1/notes', {
        body: { entityType, entityId, body: body.trim(), visibility },
      });
      setBody('');
      toast({ title: 'Note added', tone: 'success' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {notes.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No notes yet. Notes you add are visible to you and the team.
        </p>
      ) : (
        <ol className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border p-3 text-sm">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="font-medium text-fg">{n.authorName ?? 'Team'}</span>
                <span>{formatDateTimeLabel(n.createdAt, zone)}</span>
                <Badge tone="neutral">
                  {NOTE_VISIBILITY_LABELS[n.visibility] ?? humanize(n.visibility)}
                </Badge>
              </p>
              <p className="whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ol>
      )}
      {readOnly ? (
        <p className="text-sm text-fg-muted">{readOnlyReason ?? 'Notes are read-only here.'}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-2"
        >
          {error ? (
            <ErrorState
              title="Could not add note"
              message={error.message}
              correlationId={error.correlationId}
            />
          ) : null}
          <Field
            label="Add a note for the team"
            hint="Staff-only notes are never shown to you; choose below who can read yours."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                rows={3}
                maxLength={8000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            )}
          </Field>
          <fieldset className="space-y-1 text-sm">
            <legend className="mb-1 font-medium">Who can read this note</legend>
            {(['customer', 'all'] as const).map((v) => (
              <label key={v} className="flex min-h-[44px] items-center gap-2 sm:min-h-0">
                <input
                  type="radio"
                  name={visibilityName}
                  value={v}
                  checked={visibility === v}
                  onChange={() => setVisibility(v)}
                  className="h-4 w-4 accent-[var(--sx-primary)]"
                />
                <span>{NOTE_VISIBILITY_LABELS[v]}</span>
              </label>
            ))}
          </fieldset>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={body.trim().length === 0}
          >
            Add note
          </Button>
        </form>
      )}
    </div>
  );
}

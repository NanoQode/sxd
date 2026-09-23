'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TaskDto } from '@simplexd/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';

/** Tasks awaiting the customer, with completion (note optional) through the API. */
export function TasksList({
  tasks,
  zone,
  canComplete,
}: {
  tasks: TaskDto[];
  zone: string;
  canComplete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [target, setTarget] = useState<TaskDto | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  async function complete() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/tasks/${target.id}/complete`, {
        body: note.trim() ? { note: note.trim() } : {},
      });
      toast({ title: 'Task completed', tone: 'success' });
      setTarget(null);
      setNote('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="Nothing awaits your action"
        description="Tasks the team raises for you (documents to provide, decisions to make) appear here."
      />
    );
  }
  return (
    <>
      <ul className="space-y-2">
        {tasks.map((t) => {
          const href = t.projectId
            ? `/portal/projects/${t.projectId}`
            : t.serviceRequestId
              ? `/portal/requests/${t.serviceRequestId}`
              : null;
          return (
            <li
              key={t.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.title}</span>
                  <StatusBadge status={t.status} />
                  {t.requiresCustomerAction ? <Badge tone="warning">Needs you</Badge> : null}
                </p>
                {t.description ? (
                  <p className="whitespace-pre-wrap text-fg-muted">{t.description}</p>
                ) : null}
                <p className="text-xs text-fg-subtle">
                  {t.dueAt ? `Due ${formatDateTimeLabel(t.dueAt, zone)} · ` : ''}
                  created {formatDateTimeLabel(t.createdAt, zone)}
                  {t.assigneeName ? ` · assigned to ${t.assigneeName}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {href ? (
                  <Link
                    href={href}
                    className="sx-touch inline-flex items-center text-sm font-medium text-primary underline"
                  >
                    Open record
                  </Link>
                ) : null}
                {canComplete &&
                (t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked') ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setError(null);
                      setTarget(t);
                    }}
                  >
                    Mark done
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        {target ? (
          <DialogContent
            title={`Complete: ${target.title}`}
            description="Tell the team what you did; this closes the task."
            size="sm"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void complete();
              }}
              className="space-y-4"
            >
              {error ? (
                <ErrorState
                  title="Could not complete"
                  message={error.message}
                  correlationId={error.correlationId}
                />
              ) : null}
              <Field label="Note (optional)">
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setTarget(null)}
                  disabled={busy}
                >
                  Not yet
                </Button>
                <Button type="submit" loading={busy}>
                  Complete task
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

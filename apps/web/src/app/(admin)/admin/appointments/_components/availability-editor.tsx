'use client';

import { DateTime } from 'luxon';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { appointmentKindSchema, type StaffAvailabilityDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const KINDS = appointmentKindSchema.options.filter((k) => k !== 'test_booking');

type Window = StaffAvailabilityDto['windows'][number];

/** Problems with a set of weekly windows, checked before saving (the server repeats the checks). */
export function windowProblems(
  windows: Array<Pick<Window, 'weekday' | 'start' | 'end'>>,
): string[] {
  const out: string[] = [];
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  windows.forEach((w, i) => {
    if (!hhmm.test(w.start) || !hhmm.test(w.end)) out.push(`Window ${i + 1}: times must be HH:mm.`);
    else if (w.start >= w.end) out.push(`Window ${i + 1}: start must be before end.`);
  });
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i]!;
      const b = windows[j]!;
      if (a.weekday === b.weekday && a.start < b.end && b.start < a.end)
        out.push(`Windows ${i + 1} and ${j + 1} overlap on ${WEEKDAYS[a.weekday - 1]}.`);
    }
  }
  return out;
}

/**
 * Weekly working windows and time off for one staff member. Saving replaces
 * the whole weekly set; time off is added or removed one entry at a time and
 * is refused when it overlaps an existing booking.
 */
export function AvailabilityEditor({
  staffUserId,
  staffName,
  initial,
}: {
  staffUserId: string;
  staffName: string;
  initial: StaffAvailabilityDto;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [windows, setWindows] = useState<Window[]>(initial.windows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offKind, setOffKind] = useState<'leave' | 'block'>('leave');
  const [offStart, setOffStart] = useState('');
  const [offEnd, setOffEnd] = useState('');
  const [offNote, setOffNote] = useState('');
  const problems = windowProblems(windows);
  const base = `/api/v1/appointments/staff/${encodeURIComponent(staffUserId)}`;

  function update(i: number, patch: Partial<Window>) {
    setWindows((prev) => prev.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  }

  async function run(key: string, fn: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast({ title: message, tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const offStartIso = offStart
    ? DateTime.fromISO(offStart, { zone: 'Africa/Lagos' }).toISO()
    : null;
  const offEndIso = offEnd ? DateTime.fromISO(offEnd, { zone: 'Africa/Lagos' }).toISO() : null;
  const offReady = Boolean(offStartIso && offEndIso && offStart < offEnd);

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Weekly windows for {staffName}</legend>
        {windows.length === 0 ? (
          <p className="text-sm text-fg-muted">No windows: no slots are offered for this person.</p>
        ) : null}
        {windows.map((w, i) => (
          <div
            key={i}
            className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_0.7fr_0.7fr_1fr_auto] sm:items-end"
          >
            <Field label={`Window ${i + 1} day`}>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={w.weekday}
                  onChange={(e) => update(i, { weekday: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d, n) => (
                    <option key={d} value={n + 1}>
                      {d}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Start">
              {({ id }) => (
                <Input
                  id={id}
                  type="time"
                  value={w.start}
                  onChange={(e) => update(i, { start: e.target.value })}
                />
              )}
            </Field>
            <Field label="End">
              {({ id }) => (
                <Input
                  id={id}
                  type="time"
                  value={w.end}
                  onChange={(e) => update(i, { end: e.target.value })}
                />
              )}
            </Field>
            <Field label="Time zone">
              {({ id }) => (
                <Input
                  id={id}
                  value={w.timeZone}
                  onChange={(e) => update(i, { timeZone: e.target.value })}
                />
              )}
            </Field>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove window ${i + 1}`}
              onClick={() => setWindows((prev) => prev.filter((_, j) => j !== i))}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </Button>
            <fieldset className="sm:col-span-5">
              <legend className="text-xs text-fg-muted">Kinds (none ticked = all kinds)</legend>
              <div className="flex flex-wrap gap-3">
                {KINDS.map((k) => (
                  <label key={k} className="flex min-h-9 items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={w.kinds.includes(k)}
                      onChange={(e) =>
                        update(i, {
                          kinds: e.target.checked
                            ? [...w.kinds, k]
                            : w.kinds.filter((x) => x !== k),
                        })
                      }
                    />
                    {humanize(k)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setWindows((prev) => [
                ...prev,
                { weekday: 1, start: '09:00', end: '17:00', timeZone: 'Africa/Lagos', kinds: [] },
              ])
            }
            disabled={windows.length >= 50}
          >
            <Plus aria-hidden="true" className="h-4 w-4" /> Add window
          </Button>
          <Button
            size="sm"
            loading={busy === 'save'}
            disabled={problems.length > 0}
            onClick={() =>
              void run(
                'save',
                () => adminFetch(base, { method: 'PUT', body: { windows } }),
                'Working windows saved',
              )
            }
          >
            Save weekly windows
          </Button>
        </div>
        {problems.length > 0 ? (
          <Alert tone="warning" title="Fix before saving">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Time off</legend>
        {initial.timeOff.length === 0 ? (
          <p className="text-sm text-fg-muted">No upcoming time off.</p>
        ) : null}
        <ul className="space-y-1">
          {initial.timeOff.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
            >
              <span>
                {humanize(t.kind)}:{' '}
                {DateTime.fromISO(t.startsAt).setZone('Africa/Lagos').toFormat('ccc d LLL HH:mm')} →{' '}
                {DateTime.fromISO(t.endsAt).setZone('Africa/Lagos').toFormat('ccc d LLL HH:mm')}
                {t.note ? <span className="text-fg-muted"> · {t.note}</span> : null}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === t.id}
                onClick={() =>
                  void run(
                    t.id,
                    () => adminFetch(`${base}/time-off/${t.id}`, { method: 'DELETE' }),
                    'Time off removed',
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-[0.7fr_1fr_1fr] sm:items-end">
          <Field label="Kind">
            {({ id }) => (
              <NativeSelect
                id={id}
                value={offKind}
                onChange={(e) => setOffKind(e.target.value as 'leave' | 'block')}
              >
                <option value="leave">Leave</option>
                <option value="block">Block</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="From (Lagos time)">
            {({ id }) => (
              <Input
                id={id}
                type="datetime-local"
                value={offStart}
                onChange={(e) => setOffStart(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Until (Lagos time)"
            error={
              offStart && offEnd && offStart >= offEnd ? 'Must end after it starts' : undefined
            }
          >
            {({ id }) => (
              <Input
                id={id}
                type="datetime-local"
                value={offEnd}
                onChange={(e) => setOffEnd(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Note (optional)">
          {({ id }) => (
            <Textarea
              id={id}
              value={offNote}
              maxLength={300}
              onChange={(e) => setOffNote(e.target.value)}
              className="min-h-12"
            />
          )}
        </Field>
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'off'}
          disabled={!offReady}
          onClick={() =>
            void run(
              'off',
              async () => {
                await adminFetch(`${base}/time-off`, {
                  body: {
                    kind: offKind,
                    startsAt: offStartIso,
                    endsAt: offEndIso,
                    note: offNote.trim() || undefined,
                  },
                });
                setOffStart('');
                setOffEnd('');
                setOffNote('');
              },
              'Time off added',
            )
          }
        >
          Add time off
        </Button>
        <p className="text-xs text-fg-muted">
          Refused when it overlaps a booked appointment; reschedule or cancel that first.
        </p>
      </fieldset>
    </div>
  );
}

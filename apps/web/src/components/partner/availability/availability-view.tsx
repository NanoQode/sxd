'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { StaffAvailabilityDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  humanize,
  useToast,
} from '@simplexd/ui';
import { ApiClientError, errorMessage } from '@/lib/api/client-fetch';
import {
  APPOINTMENT_KINDS,
  WEEKDAY_NAMES,
  blankWindow,
  validateTimeOff,
  validateWindows,
  windowsToForm,
  type WindowForm,
} from '@/lib/partner/availability';
import { partnerFetch, serverNow } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { DualTime, LoadingBlock, RequestFailed } from '../common';

const COMMON_ZONES = ['Africa/Lagos', 'UTC', 'Europe/London', 'America/New_York'];

/**
 * Weekly working windows and time off through
 * `GET/PUT /api/v1/appointments/staff/{userId}` and
 * `POST/DELETE …/time-off[/{id}]`. Partners edit only their own availability
 * (`partner.availability.manage`); the booking engine subtracts time off and
 * existing bookings from these windows.
 */
export function AvailabilityView({
  profileStatus,
  isPartner,
}: {
  profileStatus: string | null;
  isPartner: boolean;
}) {
  const p = usePartner();
  const path = `/api/v1/appointments/staff/${encodeURIComponent(p.userId)}`;
  const availability = useQuery({
    queryKey: ['partner', 'availability', p.userId],
    queryFn: () => partnerFetch<StaffAvailabilityDto>(path),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Availability"
        description="When SimplexD may book you for visits and appointments. Windows repeat weekly in the zone you choose; time off and existing bookings are removed from them automatically."
      />
      {isPartner ? (
        <Card>
          <CardHeader>
            <CardTitle>Profile status</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Badge
              tone={
                profileStatus === 'available'
                  ? 'success'
                  : profileStatus === 'unavailable'
                    ? 'danger'
                    : 'neutral'
              }
            >
              {humanize(profileStatus ?? 'unknown')}
            </Badge>
            <p className="mt-2 text-fg-muted">
              Set by staff on your partner profile. Your weekly windows below decide when you can be
              booked.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {availability.isPending ? (
        <LoadingBlock rows={4} label="Loading availability" />
      ) : availability.isError ? (
        <RequestFailed
          error={availability.error}
          onRetry={() => void availability.refetch()}
          context="Availability"
        />
      ) : (
        <>
          <WindowsEditor
            key={JSON.stringify(availability.data.windows)}
            data={availability.data}
            path={path}
            defaultZone={p.timeZone}
          />
          <TimeOff data={availability.data} path={path} zone={p.timeZone} />
        </>
      )}
    </div>
  );
}

function WindowsEditor({
  data,
  path,
  defaultZone,
}: {
  data: StaffAvailabilityDto;
  path: string;
  defaultZone: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rows, setRows] = useState<WindowForm[]>(() => windowsToForm(data.windows));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const zones = Array.from(new Set([defaultZone, ...COMMON_ZONES, ...rows.map((r) => r.timeZone)]));
  const save = useMutation({
    mutationFn: (windows: NonNullable<ReturnType<typeof validateWindows>['windows']>) =>
      partnerFetch<StaffAvailabilityDto>(path, { method: 'PUT', body: { windows } }),
    onSuccess: (next) => {
      toast({ tone: 'success', title: 'Weekly hours saved' });
      qc.setQueryData(['partner', 'availability', next.staffUserId], next);
      setDirty(false);
    },
  });

  function change(id: string, patch: Partial<WindowForm>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Weekly hours</CardTitle>
          <p className="text-xs text-fg-muted">
            Local times in each window&apos;s zone. No kinds ticked means any appointment kind.
          </p>
        </div>
        <Badge tone={dirty ? 'warning' : 'neutral'} role="status">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {errors.length > 0 ? (
          <div role="alert" className="rounded-md border border-danger bg-danger-soft p-3 text-sm">
            <p className="font-medium">Please fix the following</p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {save.isError ? (
          <Alert tone="danger" title="Could not save">
            {errorMessage(save.error)}
          </Alert>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No windows: you cannot be booked until you add at least one.
          </p>
        ) : null}
        <ul className="space-y-3">
          {rows.map((r, i) => (
            <li key={r.id}>
              <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-4">
                <legend className="px-1 text-xs text-fg-muted">Window {i + 1}</legend>
                <Field label="Day" htmlFor={`win-${r.id}-day`}>
                  {({ id }) => (
                    <NativeSelect
                      id={id}
                      value={r.weekday}
                      onChange={(e) => change(r.id, { weekday: Number(e.target.value) })}
                    >
                      {Object.entries(WEEKDAY_NAMES).map(([n, name]) => (
                        <option key={n} value={n}>
                          {name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field label="From" htmlFor={`win-${r.id}-start`}>
                  {({ id }) => (
                    <Input
                      id={id}
                      type="time"
                      step={900}
                      value={r.start}
                      onChange={(e) => change(r.id, { start: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="To" htmlFor={`win-${r.id}-end`}>
                  {({ id }) => (
                    <Input
                      id={id}
                      type="time"
                      step={900}
                      value={r.end}
                      onChange={(e) => change(r.id, { end: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Time zone" htmlFor={`win-${r.id}-zone`}>
                  {({ id }) => (
                    <NativeSelect
                      id={id}
                      value={r.timeZone}
                      onChange={(e) => change(r.id, { timeZone: e.target.value })}
                    >
                      {zones.map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <fieldset className="sm:col-span-4">
                  <legend className="text-xs text-fg-muted">For appointment kinds</legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {APPOINTMENT_KINDS.map((k) => (
                      <label key={k} className="sx-touch flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-[var(--sx-primary)]"
                          checked={r.kinds.includes(k)}
                          onChange={(e) =>
                            change(r.id, {
                              kinds: e.target.checked
                                ? [...r.kinds, k]
                                : r.kinds.filter((x) => x !== k),
                            })
                          }
                        />
                        {humanize(k)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="sm:col-span-4">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setRows((rs) => rs.filter((x) => x.id !== r.id));
                      setDirty(true);
                    }}
                    aria-label={`Remove window ${i + 1}`}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                    Remove
                  </Button>
                </div>
              </fieldset>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={rows.length >= 50}
            onClick={() => {
              const last = rows[rows.length - 1];
              setRows((rs) => [
                ...rs,
                blankWindow(last?.timeZone ?? defaultZone, last ? (last.weekday % 7) + 1 : 1),
              ]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add window
          </Button>
          <Button
            type="button"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => {
              const v = validateWindows(rows);
              setErrors(v.errors);
              if (v.windows) save.mutate(v.windows);
            }}
          >
            Save weekly hours
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRows(windowsToForm(data.windows));
                setErrors([]);
                setDirty(false);
              }}
            >
              Discard changes
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TimeOff({ data, path, zone }: { data: StaffAvailabilityDto; path: string; zone: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [kind, setKind] = useState<'leave' | 'block'>('leave');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StaffAvailabilityDto['timeOff'][number] | null>(null);
  const setData = (next: StaffAvailabilityDto) =>
    qc.setQueryData(['partner', 'availability', next.staffUserId], next);
  const add = useMutation({
    mutationFn: (body: {
      kind: 'leave' | 'block';
      startsAt: string;
      endsAt: string;
      note?: string;
    }) => partnerFetch<StaffAvailabilityDto>(`${path}/time-off`, { body }),
    onSuccess: (next) => {
      toast({ tone: 'success', title: 'Time off added' });
      setData(next);
      setStart('');
      setEnd('');
      setNote('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      partnerFetch<StaffAvailabilityDto>(`${path}/time-off/${id}`, { method: 'DELETE' }),
    onSuccess: (next) => {
      toast({ tone: 'success', title: 'Time off removed' });
      setData(next);
      setRemoving(null);
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not remove', description: errorMessage(err) }),
  });
  const overlap = add.error instanceof ApiClientError && add.error.code === 'slot_unavailable';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time off</CardTitle>
        <p className="text-xs text-fg-muted">
          Leave or a block removes the period from your bookable hours. A period that overlaps an
          existing appointment or hold is refused; ask staff to move the booking first.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.timeOff.length === 0 ? (
          <p className="text-sm text-fg-muted">No upcoming time off.</p>
        ) : (
          <ul className="space-y-2">
            {data.timeOff.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
              >
                <div className="min-w-0 space-y-1">
                  <Badge tone={t.kind === 'leave' ? 'info' : 'neutral'}>{humanize(t.kind)}</Badge>
                  <div className="grid gap-1 sm:grid-cols-2">
                    <span>
                      From <DualTime iso={t.startsAt} zone={zone} />
                    </span>
                    <span>
                      To <DualTime iso={t.endsAt} zone={zone} />
                    </span>
                  </div>
                  {t.note ? <p className="text-fg-muted">{t.note}</p> : null}
                </div>
                <Button variant="ghost" onClick={() => setRemoving(t)}>
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = validateTimeOff(start, end, serverNow());
            if ('error' in v) {
              setFormError(v.error);
              return;
            }
            setFormError(null);
            add.mutate({ kind, ...v, ...(note.trim() ? { note: note.trim() } : {}) });
          }}
        >
          <Field label="Kind" htmlFor="timeoff-kind">
            {({ id }) => (
              <NativeSelect
                id={id}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'leave' | 'block')}
              >
                <option value="leave">Leave</option>
                <option value="block">Block</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="Note (optional)" htmlFor="timeoff-note">
            {({ id }) => (
              <Input
                id={id}
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="From"
            htmlFor="timeoff-start"
            hint="Your device's local time; stored in UTC."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            )}
          </Field>
          <Field label="To" htmlFor="timeoff-end">
            {({ id }) => (
              <Input
                id={id}
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            )}
          </Field>
          {formError || add.isError ? (
            <div className="sm:col-span-2">
              <Alert
                tone="danger"
                title={overlap ? 'Overlaps a booking' : 'Could not add time off'}
              >
                {formError ??
                  (overlap
                    ? 'That period overlaps an appointment, hold or other time off. Choose another period or ask staff to move the booking.'
                    : errorMessage(add.error))}
              </Alert>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" loading={add.isPending}>
              Add time off
            </Button>
          </div>
        </form>
      </CardContent>
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
      >
        {removing ? (
          <DialogContent
            title="Remove this time off?"
            description="The period becomes bookable again within your weekly hours."
          >
            <DialogFooter>
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                Keep
              </Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate(removing.id)}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </Card>
  );
}

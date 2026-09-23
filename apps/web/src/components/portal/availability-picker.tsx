'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type {
  AppointmentDto,
  AppointmentKind,
  AvailabilityResponse,
  AvailabilitySlotDto,
  HoldDto,
} from '@simplexd/contracts';
import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  Textarea,
  cn,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, newIdempotencyKey, portalFetch, ApiClientError } from '@/lib/portal/client';
import {
  browserTimeZone,
  formatDateInZone,
  formatInZone,
  isValidTimeZone,
  localDateKey,
} from '@/lib/portal/format';
import { ErrorState } from './error-state';

const KINDS: AppointmentKind[] = [
  'consultation',
  'viewing',
  'site_visit',
  'virtual_inspection',
  'meeting',
];

/** Groups UTC slots by the customer's local calendar day (DST safe via IANA rules). */
export function groupSlots(
  slots: AvailabilitySlotDto[],
  zone: string,
): Array<{ date: string; slots: AvailabilitySlotDto[] }> {
  const map = new Map<string, AvailabilitySlotDto[]>();
  for (const s of slots) {
    const key = localDateKey(s.start, zone);
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, list]) => ({ date, slots: list }));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Availability → hold → book (or reschedule). Every slot shows the business
 * time and the customer's time; the hold expiry is real and counts down.
 */
export function AvailabilityPicker({
  mode,
  appointmentId,
  defaultKind = 'consultation',
  defaultZone,
  serviceRequestId,
  onBooked,
}: {
  mode: 'book' | 'reschedule';
  appointmentId?: string;
  defaultKind?: AppointmentKind;
  defaultZone: string;
  serviceRequestId?: string;
  onBooked?: (a: AppointmentDto) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<AppointmentKind>(defaultKind);
  const [zone, setZone] = useState(defaultZone);
  const [zoneInput, setZoneInput] = useState(defaultZone);
  const [from, setFrom] = useState(() => isoDate(new Date()));
  const [hold, setHold] = useState<HoldDto | null>(null);
  const [holdError, setHoldError] = useState<{
    message: string;
    correlationId: string | null;
  } | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<{
    message: string;
    correlationId: string | null;
  } | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);

  const range = useMemo(() => {
    const start = new Date(`${from}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start.getTime() + 14 * 24 * 3600_000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [from]);

  const availability = useQuery({
    queryKey: ['availability', kind, zone, range?.from, range?.to],
    enabled: range !== null,
    queryFn: () =>
      portalFetch<AvailabilityResponse>(
        `/api/v1/appointments/availability?${new URLSearchParams({ kind, from: range!.from, to: range!.to, tz: zone }).toString()}`,
      ),
  });

  const grouped = useMemo(
    () => (availability.data ? groupSlots(availability.data.slots, zone) : []),
    [availability.data, zone],
  );

  async function takeHold(slot: AvailabilitySlotDto) {
    setHolding(slot.start);
    setHoldError(null);
    try {
      const created = await portalFetch<HoldDto>('/api/v1/appointments/holds', {
        body: { kind, staffUserId: slot.staffUserId, start: slot.start, customerTimeZone: zone },
      });
      setHold(created);
      setKey(newIdempotencyKey());
    } catch (err) {
      const e = describeError(err);
      setHoldError({
        message:
          err instanceof ApiClientError && err.code === 'slot_unavailable'
            ? 'Someone else took that slot a moment ago; pick another.'
            : e.message,
        correlationId: e.correlationId,
      });
      void availability.refetch();
    } finally {
      setHolding(null);
    }
  }

  async function confirm() {
    if (!hold) return;
    setBooking(true);
    setBookError(null);
    try {
      const appointment =
        mode === 'book'
          ? await portalFetch<AppointmentDto>('/api/v1/appointments', {
              idempotencyKey: key,
              body: {
                holdToken: hold.holdToken,
                kind,
                customerTimeZone: zone,
                ...(topic.trim() ? { topic: topic.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
                ...(serviceRequestId ? { serviceRequestId } : {}),
              },
            })
          : await portalFetch<AppointmentDto>(`/api/v1/appointments/${appointmentId}/reschedule`, {
              idempotencyKey: key,
              body: {
                holdToken: hold.holdToken,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
            });
      toast({
        title: mode === 'book' ? 'Appointment booked' : 'Appointment rescheduled',
        tone: 'success',
      });
      onBooked?.(appointment);
      router.push(`/portal/appointments/${appointment.id}`);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      const expired =
        err instanceof ApiClientError &&
        (err.code === 'conflict' || err.code === 'slot_unavailable' || err.status === 409);
      setBookError({
        message: expired ? `${e.message} Pick the slot again to take a fresh hold.` : e.message,
        correlationId: e.correlationId,
      });
      if (expired) {
        setHold(null);
        void availability.refetch();
      }
    } finally {
      setBooking(false);
    }
  }

  const holdSecondsLeft = hold
    ? Math.max(0, Math.floor((new Date(hold.expiresAt).getTime() - now) / 1000))
    : 0;
  const holdExpired = hold !== null && holdSecondsLeft === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {mode === 'book' ? (
            <Field label="Kind">
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as AppointmentKind);
                    setHold(null);
                  }}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          ) : null}
          <Field label="From date">
            {({ id }) => (
              <Input
                id={id}
                type="date"
                value={from}
                min={isoDate(new Date())}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Your time zone"
            hint={
              isValidTimeZone(zoneInput) ? undefined : 'Unknown zone; using the last valid one.'
            }
          >
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  list="portal-tz-suggestions"
                  value={zoneInput}
                  onChange={(e) => {
                    setZoneInput(e.target.value);
                    if (isValidTimeZone(e.target.value)) setZone(e.target.value);
                  }}
                />
                <datalist id="portal-tz-suggestions">
                  {[
                    browserTimeZone(),
                    'Africa/Lagos',
                    'Europe/London',
                    'America/New_York',
                    'America/Toronto',
                    'Asia/Dubai',
                  ].map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </div>
            )}
          </Field>
        </div>

        {availability.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-5 w-1/3" label="Loading availability" />
            <Skeleton className="h-10 w-full" label="Loading availability" />
            <Skeleton className="h-10 w-full" label="Loading availability" />
          </div>
        ) : availability.isError ? (
          <ErrorState
            title="Availability did not load"
            message={describeError(availability.error).message}
            correlationId={describeError(availability.error).correlationId}
            action={
              <Button type="button" variant="secondary" onClick={() => void availability.refetch()}>
                Try again
              </Button>
            }
          />
        ) : availability.data ? (
          <>
            <p className="text-sm text-fg-muted">
              {humanize(availability.data.kind)} · {availability.data.durationMinutes} minutes ·
              business time zone {availability.data.businessTimeZone}
              {zone !== availability.data.businessTimeZone ? `, shown in ${zone} too` : ''} ·
              minimum notice {availability.data.minNoticeHours} h
              {availability.data.providerBusyIncluded
                ? ' · organiser calendar busy times included'
                : ''}
            </p>
            {availability.data.unavailableReason ? (
              <Alert tone="warning" title="No bookable slots">
                {availability.data.unavailableReason === 'no_staff_configured'
                  ? 'No team member has availability configured for this kind of appointment yet. Message the team and they will schedule it with you.'
                  : 'This kind of appointment cannot be booked online; the team schedules it with you.'}
              </Alert>
            ) : grouped.length === 0 ? (
              <Alert tone="info" title="No free slots in this two-week window">
                Try a later start date.
              </Alert>
            ) : (
              <div className="space-y-4">
                {holdError ? (
                  <ErrorState
                    title="Could not hold that slot"
                    message={holdError.message}
                    correlationId={holdError.correlationId}
                  />
                ) : null}
                {grouped.map((day) => (
                  <section key={day.date} aria-labelledby={`day-${day.date}`}>
                    <h3 id={`day-${day.date}`} className="mb-2 text-sm font-medium">
                      {formatDateInZone(`${day.date}T12:00:00`, zone)}
                    </h3>
                    <ul className="flex flex-wrap gap-2">
                      {day.slots.map((s) => {
                        const selected =
                          hold?.start === s.start && hold.staffUserId === s.staffUserId;
                        return (
                          <li key={`${s.start}-${s.staffUserId}`}>
                            <button
                              type="button"
                              onClick={() => void takeHold(s)}
                              disabled={holding !== null}
                              aria-pressed={selected}
                              className={cn(
                                'sx-transition sx-touch rounded-md border px-3 text-sm',
                                selected
                                  ? 'border-primary bg-primary-soft text-primary'
                                  : 'border-border-strong hover:bg-bg-sunken',
                                holding === s.start && 'opacity-60',
                              )}
                              title={
                                s.label.sameZone
                                  ? s.label.business
                                  : `${s.label.customer} (your time) · ${s.label.business} (business)`
                              }
                            >
                              {formatInZone(s.start, zone, 'HH:mm')}
                              {!s.label.sameZone ? (
                                <span className="ml-1 text-xs text-fg-muted">
                                  (
                                  {formatInZone(
                                    s.start,
                                    availability.data!.businessTimeZone,
                                    'HH:mm',
                                  )}{' '}
                                  Lagos)
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>

      <aside
        className="space-y-4 rounded-lg border border-border bg-bg-elevated p-4"
        aria-live="polite"
      >
        <h3 className="font-medium">{mode === 'book' ? 'Your booking' : 'New time'}</h3>
        {!hold ? (
          <p className="text-sm text-fg-muted">
            Pick a slot to hold it for a few minutes while you confirm.
          </p>
        ) : (
          <>
            <dl className="space-y-1 text-sm">
              <div>
                <dt className="text-fg-muted">Your time ({zone})</dt>
                <dd className="font-medium">{hold.label.customer}</dd>
              </div>
              {!hold.label.sameZone ? (
                <div>
                  <dt className="text-fg-muted">Business time</dt>
                  <dd>
                    {hold.label.business}
                    {hold.label.dateDiffers ? ' (different calendar day)' : ''}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-fg-muted">Hold</dt>
                <dd>
                  {holdExpired
                    ? 'Expired; pick the slot again.'
                    : `Reserved for ${Math.floor(holdSecondsLeft / 60)}:${String(holdSecondsLeft % 60).padStart(2, '0')}`}
                </dd>
              </div>
            </dl>
            {bookError ? (
              <ErrorState
                title="Could not confirm"
                message={bookError.message}
                correlationId={bookError.correlationId}
              />
            ) : null}
            {mode === 'book' ? (
              <>
                <Field label="Topic">
                  {({ id }) => (
                    <Input
                      id={id}
                      maxLength={200}
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Notes for the team">
                  {({ id }) => (
                    <Textarea
                      id={id}
                      rows={3}
                      maxLength={4000}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  )}
                </Field>
              </>
            ) : (
              <Field label="Reason for rescheduling">
                {({ id }) => (
                  <Input
                    id={id}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                )}
              </Field>
            )}
            <Button
              type="button"
              className="w-full"
              onClick={() => void confirm()}
              loading={booking}
              disabled={holdExpired}
            >
              {mode === 'book' ? 'Confirm booking' : 'Confirm new time'}
            </Button>
          </>
        )}
      </aside>
    </div>
  );
}

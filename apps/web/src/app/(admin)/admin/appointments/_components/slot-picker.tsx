'use client';

import { DateTime } from 'luxon';
import { useState } from 'react';
import { appointmentKindSchema, type AppointmentKind, type AvailabilityResponse, type HoldDto } from '@simplexd/contracts';
import { Alert, Button, Field, Input, NativeSelect, humanize } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

const ZONE = 'Africa/Lagos';

/** Builds the availability query for `days` days starting on a Lagos calendar date. */
export function availabilityUrl(input: { kind: string; staffUserId?: string; fromDate: string; days: number; tz?: string }): string {
  const from = DateTime.fromISO(input.fromDate, { zone: ZONE }).startOf('day');
  const to = from.plus({ days: input.days });
  const params = new URLSearchParams({
    kind: input.kind,
    from: from.toUTC().toISO()!,
    to: to.toUTC().toISO()!,
    tz: input.tz ?? ZONE,
  });
  if (input.staffUserId) params.set('staffUserId', input.staffUserId);
  return `/api/v1/appointments/availability?${params.toString()}`;
}

/**
 * Finds free slots and takes a short hold on one. Two people racing for the
 * same slot both see it free; only one hold succeeds (the server's exclusion
 * constraint), and the loser is told to pick again.
 */
export function SlotPicker({
  staff,
  fixedKind,
  fixedStaffUserId,
  onHeld,
}: {
  staff: Array<{ userId: string; name: string }>;
  fixedKind?: AppointmentKind;
  fixedStaffUserId?: string;
  onHeld: (hold: HoldDto) => void;
}) {
  const [kind, setKind] = useState<string>(fixedKind ?? 'consultation');
  const [staffUserId, setStaffUserId] = useState(fixedStaffUserId ?? '');
  const [fromDate, setFromDate] = useState(DateTime.now().setZone(ZONE).toISODate()!);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setBusy('search');
    setError(null);
    try {
      setAvailability(await adminFetch<AvailabilityResponse>(availabilityUrl({ kind, staffUserId: staffUserId || undefined, fromDate, days: 7 })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function hold(start: string, slotStaff: string) {
    setBusy(start);
    setError(null);
    try {
      const h = await adminFetch<HoldDto>('/api/v1/appointments/holds', {
        body: { kind, staffUserId: slotStaff, start, customerTimeZone: ZONE },
      });
      onHeld(h);
    } catch (err) {
      setError(`${errorMessage(err)} Pick another slot or search again.`);
    } finally {
      setBusy(null);
    }
  }

  const byDay = new Map<string, AvailabilityResponse['slots']>();
  for (const s of availability?.slots ?? []) {
    const day = DateTime.fromISO(s.start).setZone(ZONE).toISODate()!;
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  const staffName = (id: string) => staff.find((s) => s.userId === id)?.name ?? 'staff';

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
        {fixedKind ? null : (
          <Field label="Kind">
            {({ id }) => (
              <NativeSelect id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                {appointmentKindSchema.options
                  .filter((k) => k !== 'test_booking')
                  .map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </Field>
        )}
        {fixedStaffUserId ? null : (
          <Field label="Staff member">
            {({ id }) => (
              <NativeSelect id={id} value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)}>
                <option value="">Anyone available</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label="Week starting (Lagos date)">
          {({ id }) => <Input id={id} type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />}
        </Field>
        <Button variant="secondary" loading={busy === 'search'} onClick={() => void search()}>
          Find free slots
        </Button>
      </div>
      {error ? (
        <Alert tone="danger" title="Could not continue">
          {error}
        </Alert>
      ) : null}
      {availability ? (
        availability.unavailableReason ? (
          <Alert tone="info" title="No bookable slots">
            {availability.unavailableReason === 'no_staff_configured'
              ? 'No staff availability is configured for this kind of appointment.'
              : 'This kind of appointment is not bookable.'}
          </Alert>
        ) : availability.slots.length === 0 ? (
          <p className="text-sm text-fg-muted">No free slots in this week. Try the next week or another staff member.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-fg-muted">
              {availability.durationMinutes}-minute slots, {availability.minNoticeHours} h minimum notice. Times in {availability.businessTimeZone}.
              {availability.providerBusyIncluded ? ' Organiser calendar busy times are excluded.' : ' External calendar busy times were not available.'}
            </p>
            {[...byDay.entries()].map(([day, slots]) => (
              <fieldset key={day} className="rounded-md border border-border p-2">
                <legend className="px-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{DateTime.fromISO(day).toFormat('ccc d LLL')}</legend>
                <div className="flex flex-wrap gap-1">
                  {slots.map((s) => (
                    <Button key={`${s.start}-${s.staffUserId}`} size="sm" variant="secondary" loading={busy === s.start} onClick={() => void hold(s.start, s.staffUserId)} title={s.label.customer}>
                      {DateTime.fromISO(s.start).setZone(ZONE).toFormat('HH:mm')}
                      {staffUserId ? '' : ` · ${staffName(s.staffUserId)}`}
                    </Button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

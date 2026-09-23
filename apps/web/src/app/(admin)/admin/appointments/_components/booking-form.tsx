'use client';

import { DateTime } from 'luxon';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppointmentDto, HoldDto } from '@simplexd/contracts';
import { Alert, Button, Field, Input, Textarea, humanize, useToast } from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { SlotPicker } from './slot-picker';

/**
 * Staff booking through the same holds as customers: find a slot, hold it,
 * then book. The API records the signed-in staff member as the booking
 * contact, so the customer's details go into the notes and the booking is
 * linked to the request or lead.
 */
export function BookingForm({
  staff,
  serviceRequestId,
  leadId,
  customerHint,
}: {
  staff: Array<{ userId: string; name: string }>;
  serviceRequestId?: string;
  leadId?: string;
  customerHint?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [hold, setHold] = useState<HoldDto | null>(null);
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState(customerHint ? `Customer: ${customerHint}\n` : '');
  const [srId, setSrId] = useState(serviceRequestId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function book() {
    if (!hold) return;
    setBusy(true);
    setError(null);
    try {
      const appt = await adminFetch<AppointmentDto>('/api/v1/appointments', {
        body: {
          holdToken: hold.holdToken,
          kind: hold.kind,
          customerTimeZone: 'Africa/Lagos',
          topic: topic.trim() || undefined,
          notes: notes.trim() || undefined,
          serviceRequestId: srId.trim() || undefined,
          leadId,
        },
        idempotent: true,
      });
      toast({ title: 'Appointment booked', description: appt.calendarNote, tone: 'success' });
      router.push(`/admin/appointments?date=${appt.startsAt.slice(0, 10)}#appt-${appt.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Booking on behalf of a customer">
        The booking API records you as the booking contact. Put the customer&apos;s name and how to
        reach them in the notes, and link the service request so the appointment appears on it.
      </Alert>
      {error ? (
        <Alert tone="danger" title="Could not book">
          {error}
        </Alert>
      ) : null}
      {hold ? (
        <Alert
          tone="success"
          title={`Held: ${humanize(hold.kind)} · ${DateTime.fromISO(hold.start).setZone('Africa/Lagos').toFormat('cccc d LLLL, HH:mm')}`}
        >
          With {staff.find((s) => s.userId === hold.staffUserId)?.name ?? 'staff'}. The hold expires
          at {DateTime.fromISO(hold.expiresAt).setZone('Africa/Lagos').toFormat('HH:mm')}; book
          before then.{' '}
          <button type="button" className="underline" onClick={() => setHold(null)}>
            Choose another slot
          </button>
        </Alert>
      ) : (
        <SlotPicker staff={staff} onHeld={setHold} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Topic">
          {({ id }) => (
            <Input
              id={id}
              value={topic}
              maxLength={200}
              onChange={(e) => setTopic(e.target.value)}
            />
          )}
        </Field>
        <Field label="Service request id (optional)">
          {({ id }) => <Input id={id} value={srId} onChange={(e) => setSrId(e.target.value)} />}
        </Field>
      </div>
      <Field label="Notes (customer name, phone, access instructions)">
        {({ id }) => (
          <Textarea
            id={id}
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
            className="min-h-24"
          />
        )}
      </Field>
      <Button loading={busy} disabled={!hold} onClick={() => void book()}>
        Book appointment
      </Button>
    </div>
  );
}

'use client';

import { DateTime } from 'luxon';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppointmentDto, HoldDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { ApiAction } from '@/components/admin/api-action';
import { SlotPicker } from './slot-picker';

/** Staff actions on one appointment: confirm, reschedule onto a fresh hold, cancel with a reason, retry calendar sync. */
export function AppointmentActions({
  appointment: a,
  staff,
}: {
  appointment: Pick<
    AppointmentDto,
    | 'id'
    | 'kind'
    | 'status'
    | 'staff'
    | 'canReschedule'
    | 'canCancel'
    | 'calendarSyncStatus'
    | 'conferenceStatus'
    | 'icsPath'
  >;
  staff: Array<{ userId: string; name: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [hold, setHold] = useState<HoldDto | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reschedule() {
    if (!hold) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/appointments/${a.id}/reschedule`, {
        body: { holdToken: hold.holdToken, reason: reason.trim() || undefined },
        idempotent: true,
      });
      toast({
        title: 'Appointment rescheduled',
        description: 'Calendar sync follows automatically.',
        tone: 'success',
      });
      setOpen(false);
      setHold(null);
      setReason('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const active = !['cancelled', 'completed', 'no_show'].includes(a.status);
  const syncProblem =
    ['failed', 'conflict'].includes(a.calendarSyncStatus) || a.conferenceStatus === 'failed';
  return (
    <span className="flex flex-wrap items-center gap-1">
      {a.status === 'pending_confirmation' ? (
        <ApiAction
          path={`/api/v1/appointments/${a.id}/confirm`}
          label="Confirm"
          variant="primary"
          successMessage="Appointment confirmed"
        />
      ) : null}
      {active && a.canReschedule ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Reschedule
        </Button>
      ) : null}
      {active && a.canCancel ? (
        <ApiAction
          path={`/api/v1/appointments/${a.id}/cancel`}
          reasonKey="reason"
          label="Cancel"
          variant="ghost"
          confirm={{
            title: 'Cancel this appointment?',
            description: 'The guest is notified and the calendar event is cancelled.',
            requireReason: true,
            confirmLabel: 'Cancel appointment',
            tone: 'danger',
          }}
          successMessage="Appointment cancelled"
        />
      ) : null}
      {syncProblem ? (
        <ApiAction
          path={`/api/v1/appointments/${a.id}/retry-sync`}
          label="Retry calendar sync"
          successMessage="Sync queued"
        />
      ) : null}
      <a href={a.icsPath} className="text-sm underline">
        .ics
      </a>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title="Reschedule"
          description="Pick a new slot with the same kind and organiser. The old time is released only when the new one is booked."
          size="lg"
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Could not reschedule">
                {error}
              </Alert>
            ) : null}
            {hold ? (
              <Alert
                tone="info"
                title={`Held: ${DateTime.fromISO(hold.start).setZone('Africa/Lagos').toFormat('ccc d LLL, HH:mm')}`}
              >
                The hold expires at{' '}
                {DateTime.fromISO(hold.expiresAt).setZone('Africa/Lagos').toFormat('HH:mm')}.{' '}
                <button type="button" className="underline" onClick={() => setHold(null)}>
                  Choose another
                </button>
              </Alert>
            ) : (
              <SlotPicker
                staff={staff}
                fixedKind={a.kind}
                fixedStaffUserId={a.staff.id}
                onHeld={setHold}
              />
            )}
            <Field label="Reason (optional, shared with the guest)">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  className="min-h-16"
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Close
              </Button>
              <Button loading={busy} disabled={!hold} onClick={() => void reschedule()}>
                Move appointment
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

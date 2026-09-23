'use client';

import { CalendarPlus, RefreshCw, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppointmentDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { AvailabilityPicker } from './availability-picker';
import { ErrorState } from './error-state';

/**
 * Cancel (reason), reschedule (fresh hold), ICS download, Meet link shown only
 * when the conference is ready, and a retry that is offered only to staff who
 * hold appointments.manage_all (the endpoint's real rule).
 */
export function AppointmentActions({
  appointment,
  isStaff,
  customerZone,
}: {
  appointment: AppointmentDto;
  isStaff: boolean;
  customerZone: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  async function cancel() {
    if (reason.trim().length < 2) {
      setError({ message: 'Give a short reason for cancelling.', correlationId: null });
      return;
    }
    setBusy('cancel');
    setError(null);
    try {
      await portalFetch(`/api/v1/appointments/${appointment.id}/cancel`, {
        body: { reason: reason.trim() },
      });
      toast({ title: 'Appointment cancelled', tone: 'success' });
      setCancelOpen(false);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    setError(null);
    try {
      await portalFetch(`/api/v1/appointments/${appointment.id}/retry-sync`, {
        method: 'POST',
        body: {},
      });
      toast({
        title: 'Retry queued',
        description: 'The worker records the real outcome; refresh in a moment.',
      });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(null);
    }
  }

  const active = ['pending_confirmation', 'confirmed', 'rescheduled'].includes(appointment.status);
  const meetRequested = appointment.meetingProvider === 'google_meet';
  const syncTrouble =
    appointment.calendarSyncStatus === 'failed' ||
    appointment.conferenceStatus === 'failed' ||
    appointment.calendarSyncStatus === 'conflict';

  return (
    <div className="space-y-4">
      {error && !cancelOpen ? (
        <ErrorState message={error.message} correlationId={error.correlationId} />
      ) : null}
      <div className="space-y-2 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Meeting</span>
          {meetRequested ? (
            appointment.conferenceStatus === 'ready' && appointment.meetingUrl ? (
              <Badge tone="success">Google Meet ready</Badge>
            ) : appointment.conferenceStatus === 'failed' ? (
              <Badge tone="danger">Meet link failed</Badge>
            ) : (
              <Badge tone="warning">Meet link pending</Badge>
            )
          ) : (
            <Badge tone="neutral">{appointment.meetingProvider.replace(/_/g, ' ')}</Badge>
          )}
        </p>
        <p className="text-fg-muted">{appointment.calendarNote}</p>
        {appointment.locationNote ? <p>Location: {appointment.locationNote}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {appointment.conferenceStatus === 'ready' && appointment.meetingUrl ? (
          <a
            href={appointment.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="sx-touch inline-flex items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary hover:bg-primary-hover"
          >
            <Video aria-hidden="true" className="h-4 w-4" />
            Join Google Meet
          </a>
        ) : null}
        {active ? (
          <a
            href={appointment.icsPath}
            className="sx-touch inline-flex items-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 text-sm font-medium hover:bg-bg-sunken"
            download
          >
            <CalendarPlus aria-hidden="true" className="h-4 w-4" />
            Add to calendar (.ics)
          </a>
        ) : null}
        {active && appointment.canReschedule ? (
          <Button type="button" variant="secondary" onClick={() => setRescheduleOpen(true)}>
            Reschedule
          </Button>
        ) : null}
        {active && appointment.canCancel ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              setError(null);
              setReason('');
              setCancelOpen(true);
            }}
          >
            Cancel
          </Button>
        ) : null}
        {active && syncTrouble && isStaff ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void retry()}
            loading={busy === 'retry'}
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            Retry calendar sync
          </Button>
        ) : null}
      </div>
      {active && !appointment.canReschedule ? (
        <p className="text-xs text-fg-muted">
          Rescheduling online is closed inside the minimum notice window; message the team to move
          it.
        </p>
      ) : null}
      {active && syncTrouble && !isStaff ? (
        <Alert tone="warning" title="Calendar sync needs attention">
          The team can retry the sync from their console; your booking itself is unaffected and the
          .ics download still works.
        </Alert>
      ) : null}
      {!active ? (
        <p className="text-sm text-fg-muted">
          This appointment is {appointment.status.replace(/_/g, ' ')}
          {appointment.cancellationReason ? `: ${appointment.cancellationReason}` : '.'}
        </p>
      ) : null}
      <p className="text-xs text-fg-muted">Cancellation policy: {appointment.cancellationPolicy}</p>

      <Dialog open={cancelOpen} onOpenChange={(o) => !o && setCancelOpen(false)}>
        <DialogContent
          title="Cancel this appointment"
          description="The organiser is notified and the calendar event is removed."
          size="sm"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void cancel();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not cancel"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Reason" required>
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCancelOpen(false)}
                disabled={busy === 'cancel'}
              >
                Keep it
              </Button>
              <Button type="submit" variant="danger" loading={busy === 'cancel'}>
                Cancel appointment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={rescheduleOpen} onOpenChange={(o) => !o && setRescheduleOpen(false)}>
        <DialogContent
          title="Reschedule"
          description="Pick a new slot; the old time is released only when the new one is confirmed."
          size="lg"
        >
          <AvailabilityPicker
            mode="reschedule"
            appointmentId={appointment.id}
            defaultKind={appointment.kind}
            defaultZone={customerZone}
            onBooked={() => setRescheduleOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

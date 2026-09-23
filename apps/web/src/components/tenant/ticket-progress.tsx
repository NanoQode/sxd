import { CheckCircle2, Circle, CircleDot, XCircle } from 'lucide-react';
import type { WorkOrderDto } from '@simplexd/contracts';
import { cn, formatDateTimeLabel } from '@simplexd/ui';
import { TICKET_STATUS_COPY, ticketEvents, ticketProgress, type StepState } from '@/lib/tenant/model';

const STATE_WORDS: Record<StepState, string> = {
  done: 'done',
  current: 'current step',
  upcoming: 'not yet',
  ended: 'ended here',
};

/**
 * Where the ticket stands on the maintenance path (steps with icons and
 * words) and the dated events the work order records. Steps that the API
 * does not timestamp are shown without dates rather than with invented ones.
 */
export function TicketProgress({
  ticket,
  zone,
}: {
  ticket: Pick<
    WorkOrderDto,
    | 'id'
    | 'status'
    | 'createdAt'
    | 'updatedAt'
    | 'approvedAt'
    | 'completedAt'
    | 'verifiedAt'
    | 'assigneeName'
  >;
  zone: string;
}) {
  const steps = ticketProgress(ticket);
  const events = ticketEvents(ticket);
  return (
    <div className="space-y-5">
      <p className="text-sm">
        {TICKET_STATUS_COPY[ticket.status]}
        {ticket.status === 'assigned' && ticket.assigneeName
          ? ` Assigned to ${ticket.assigneeName}.`
          : ''}
      </p>
      <ol aria-label="Ticket progress" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {steps.map((s) => {
          const Icon =
            s.state === 'done'
              ? CheckCircle2
              : s.state === 'current'
                ? CircleDot
                : s.state === 'ended'
                  ? XCircle
                  : Circle;
          return (
            <li
              key={s.key}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md border p-2 text-sm',
                s.state === 'current' && 'border-primary bg-primary-soft font-medium',
                s.state === 'done' && 'border-border bg-bg-elevated',
                s.state === 'upcoming' && 'border-dashed border-border text-fg-muted',
                s.state === 'ended' && 'border-border bg-bg-sunken font-medium',
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  'h-4 w-4 shrink-0',
                  s.state === 'done' && 'text-success',
                  s.state === 'current' && 'text-primary',
                  s.state === 'ended' && 'text-danger',
                )}
              />
              <span>
                {s.label}
                <span className="sr-only"> ({STATE_WORDS[s.state]})</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div>
        <h3 className="mb-2 text-sm font-medium">Recorded dates</h3>
        <ol className="space-y-3 border-l border-border pl-4">
          {events.map((e) => (
            <li key={e.id} className="relative text-sm">
              <span
                aria-hidden="true"
                className="absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full bg-primary"
              />
              <p className="font-medium">{e.title}</p>
              <p className="text-xs text-fg-muted">
                <time dateTime={e.at}>{formatDateTimeLabel(e.at, zone)}</time>
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

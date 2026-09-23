import type { DeliveryLogItemDto } from '@simplexd/contracts';
import { cn } from '@simplexd/ui';
import { fmtDate } from '../../_components/bits';

const TONES: Record<DeliveryLogItemDto['timeline'][number]['state'], string> = {
  queued: 'bg-fg-muted',
  accepted: 'bg-info',
  sent: 'bg-info',
  delivered: 'bg-success',
  failed: 'bg-danger',
  bounced: 'bg-danger',
  rejected: 'bg-danger',
  suppressed: 'bg-warning',
};

/** Ordered status steps of one attempt: queued → accepted/sent → delivered/failed. */
export function DeliveryTimeline({ steps }: { steps: DeliveryLogItemDto['timeline'] }) {
  return (
    <ol className="space-y-1.5" aria-label="Status timeline">
      {steps.map((s, i) => (
        <li key={`${s.state}-${i}`} className="flex items-start gap-2 text-sm">
          <span
            aria-hidden="true"
            className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', TONES[s.state])}
          />
          <span className="min-w-0">
            <span className="font-medium">{s.label}</span>
            {s.at ? <span className="ml-2 text-xs text-fg-muted">{fmtDate(s.at)}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

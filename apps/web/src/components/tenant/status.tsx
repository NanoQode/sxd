import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Hammer,
  PauseCircle,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { LeaseStatus, WorkOrderStatus } from '@simplexd/contracts';
import { Badge } from '@simplexd/ui';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'gold';

const TICKET: Record<WorkOrderStatus, { tone: Tone; icon: typeof Clock; label: string }> = {
  requested: { tone: 'info', icon: Clock, label: 'Received' },
  triaged: { tone: 'info', icon: CircleDashed, label: 'Reviewed' },
  assigned: { tone: 'primary', icon: UserCheck, label: 'Contractor assigned' },
  in_progress: { tone: 'primary', icon: Hammer, label: 'Work under way' },
  awaiting_approval: { tone: 'warning', icon: PauseCircle, label: 'Awaiting owner approval' },
  approved: { tone: 'primary', icon: CheckCircle2, label: 'Approved' },
  completed: { tone: 'success', icon: CheckCircle2, label: 'Work completed' },
  verified: { tone: 'success', icon: CheckCircle2, label: 'Checked' },
  closed: { tone: 'neutral', icon: CheckCircle2, label: 'Closed' },
  rejected: { tone: 'danger', icon: XCircle, label: 'Declined' },
  cancelled: { tone: 'neutral', icon: XCircle, label: 'Cancelled' },
};

/** Ticket status in the tenant's words: icon plus label, never colour alone. */
export function TicketStatusBadge({ status }: { status: WorkOrderStatus }) {
  const entry = TICKET[status] ?? { tone: 'neutral' as const, icon: CircleDashed, label: status };
  const Icon = entry.icon;
  return (
    <Badge tone={entry.tone}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {entry.label}
    </Badge>
  );
}

const LEASE: Record<LeaseStatus, { tone: Tone; icon: typeof Clock; label: string }> = {
  draft: { tone: 'neutral', icon: CircleDashed, label: 'Draft' },
  pending_signature: { tone: 'warning', icon: Clock, label: 'Awaiting signature' },
  active: { tone: 'success', icon: CheckCircle2, label: 'Active' },
  expiring: { tone: 'warning', icon: AlertTriangle, label: 'Expiring' },
  ended: { tone: 'neutral', icon: XCircle, label: 'Ended' },
  terminated: { tone: 'danger', icon: XCircle, label: 'Terminated' },
};

export function LeaseStatusBadge({ status }: { status: LeaseStatus }) {
  const entry = LEASE[status] ?? { tone: 'neutral' as const, icon: CircleDashed, label: status };
  const Icon = entry.icon;
  return (
    <Badge tone={entry.tone}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {entry.label}
    </Badge>
  );
}

const PRIORITY: Record<string, Tone> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge tone={PRIORITY[priority] ?? 'neutral'}>
      {priority === 'urgent' ? <AlertTriangle aria-hidden="true" className="h-3 w-3" /> : null}
      {priority.charAt(0).toUpperCase() + priority.slice(1)} priority
    </Badge>
  );
}

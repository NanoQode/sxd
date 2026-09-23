import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Info,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import { Badge } from './badge';

const map: Record<
  string,
  {
    tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'gold';
    icon: typeof Clock;
    label?: string;
  }
> = {
  inquiry: { tone: 'info', icon: Info },
  triage: { tone: 'info', icon: CircleDashed },
  quoted: { tone: 'primary', icon: Clock },
  accepted: { tone: 'success', icon: CheckCircle2 },
  awaiting_payment: { tone: 'warning', icon: Clock },
  in_progress: { tone: 'primary', icon: CircleDashed },
  in_review: { tone: 'info', icon: Clock },
  delivered: { tone: 'success', icon: CheckCircle2 },
  completed: { tone: 'success', icon: CheckCircle2 },
  rejected: { tone: 'danger', icon: XCircle },
  paused: { tone: 'warning', icon: PauseCircle },
  cancelled: { tone: 'neutral', icon: XCircle },
  draft: { tone: 'neutral', icon: CircleDashed },
  issued: { tone: 'info', icon: Clock },
  partially_paid: { tone: 'warning', icon: Clock },
  paid: { tone: 'success', icon: CheckCircle2 },
  overdue: { tone: 'danger', icon: AlertTriangle },
  void: { tone: 'neutral', icon: XCircle },
  pending: { tone: 'warning', icon: Clock },
  successful: { tone: 'success', icon: CheckCircle2 },
  failed: { tone: 'danger', icon: XCircle },
  uncertain: { tone: 'warning', icon: AlertTriangle },
  published: { tone: 'success', icon: CheckCircle2 },
  unpublished: { tone: 'neutral', icon: PauseCircle },
  archived: { tone: 'neutral', icon: XCircle },
  connected: { tone: 'success', icon: CheckCircle2 },
  configured_unverified: {
    tone: 'warning',
    icon: AlertTriangle,
    label: 'Configured, not verified',
  },
  disconnected: { tone: 'neutral', icon: XCircle },
  degraded: { tone: 'warning', icon: AlertTriangle },
  expired: { tone: 'danger', icon: AlertTriangle },
  disabled: { tone: 'neutral', icon: PauseCircle },
  open: { tone: 'warning', icon: AlertTriangle },
  resolved: { tone: 'success', icon: CheckCircle2 },
  verified: { tone: 'success', icon: CheckCircle2 },
  closed: { tone: 'neutral', icon: CheckCircle2 },
};

export function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Status pill: icon + words, never colour alone. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const entry = map[status] ?? { tone: 'neutral' as const, icon: CircleDashed };
  const Icon = entry.icon;
  return (
    <Badge tone={entry.tone}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {label ?? entry.label ?? humanize(status)}
    </Badge>
  );
}

import { CheckCircle2, CircleDashed, Clock, TriangleAlert, XCircle } from 'lucide-react';
import { Badge } from '@simplexd/ui';

export type ServiceAvailability =
  'pending_operations_confirmation' | 'available' | 'limited' | 'on_request' | 'unavailable';

const meta: Record<
  ServiceAvailability,
  { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' | 'danger'; icon: typeof Clock }
> = {
  available: { label: 'Service available', tone: 'success', icon: CheckCircle2 },
  limited: { label: 'Limited availability', tone: 'warning', icon: TriangleAlert },
  on_request: { label: 'On request', tone: 'info', icon: Clock },
  pending_operations_confirmation: {
    label: 'Availability pending confirmation',
    tone: 'neutral',
    icon: CircleDashed,
  },
  unavailable: { label: 'Not available', tone: 'danger', icon: XCircle },
};

export function availabilityLabel(value: ServiceAvailability): string {
  return meta[value].label;
}

/** Service availability is an operational fact, separate from map coverage. */
export function AvailabilityBadge({ value }: { value: ServiceAvailability }) {
  const m = meta[value];
  const Icon = m.icon;
  return (
    <Badge tone={m.tone}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {m.label}
    </Badge>
  );
}

export type RecommendationStatus =
  'insufficient_local_evidence' | 'assumption_mode_only' | 'eligible' | 'gated_by_policy';

export function recommendationLabel(status: RecommendationStatus): string {
  switch (status) {
    case 'eligible':
      return 'Eligible for financial ranking';
    case 'assumption_mode_only':
      return 'Assumption-mode comparison only';
    case 'gated_by_policy':
      return 'Ranking gated by policy';
    case 'insufficient_local_evidence':
      return 'More local data needed';
  }
}

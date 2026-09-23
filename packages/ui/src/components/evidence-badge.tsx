import {
  AlertTriangle,
  BookOpen,
  CircleHelp,
  Clock,
  Map,
  Sigma,
  ShieldCheck,
  User,
} from 'lucide-react';
import { cn } from '../cn';

export type EvidenceBadgeKind =
  | 'sourced_observation'
  | 'verified_operational_record'
  | 'regional_context'
  | 'model_estimate'
  | 'user_assumption'
  | 'unknown'
  | 'stale'
  | 'disputed';

const meta: Record<
  EvidenceBadgeKind,
  { label: string; icon: typeof BookOpen; cssVar: string; description: string }
> = {
  sourced_observation: {
    label: 'Sourced observation',
    icon: BookOpen,
    cssVar: '--sx-badge-sourced',
    description: 'Read from a named published source with retrieval and observation dates.',
  },
  verified_operational_record: {
    label: 'Verified record',
    icon: ShieldCheck,
    cssVar: '--sx-badge-verified',
    description: 'First-party record verified by SimplexD staff.',
  },
  regional_context: {
    label: 'Statewide context',
    icon: Map,
    cssVar: '--sx-badge-regional',
    description: 'A statewide or regional figure; not a city value.',
  },
  model_estimate: {
    label: 'Model estimate',
    icon: Sigma,
    cssVar: '--sx-badge-model',
    description: 'Computed from assumptions and policy bounds.',
  },
  user_assumption: {
    label: 'Your assumption',
    icon: User,
    cssVar: '--sx-badge-assumption',
    description: 'Entered by you for this scenario.',
  },
  unknown: {
    label: 'Unknown',
    icon: CircleHelp,
    cssVar: '--sx-badge-unknown',
    description: 'No evidence collected yet.',
  },
  stale: {
    label: 'Stale',
    icon: Clock,
    cssVar: '--sx-badge-stale',
    description: 'Older than the freshness policy; excluded from default ranking.',
  },
  disputed: {
    label: 'Disputed',
    icon: AlertTriangle,
    cssVar: '--sx-badge-disputed',
    description: 'Under review after a challenge.',
  },
};

/** Never a single generic "Verified" label: each badge states what kind of evidence it is. */
export function EvidenceBadge({
  kind,
  className,
  showDescription = false,
}: {
  kind: EvidenceBadgeKind;
  className?: string;
  showDescription?: boolean;
}) {
  const m = meta[kind];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        className,
      )}
      style={{
        color: `var(${m.cssVar})`,
        borderColor: `color-mix(in srgb, var(${m.cssVar}) 40%, transparent)`,
        background: `color-mix(in srgb, var(${m.cssVar}) 12%, transparent)`,
      }}
      title={m.description}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      {m.label}
      {showDescription ? <span className="sr-only">: {m.description}</span> : null}
    </span>
  );
}

export const evidenceBadgeMeta = meta;

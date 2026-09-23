import { AlertTriangle, CheckCircle2, CircleDashed, Info, XCircle } from 'lucide-react';
import { Badge, EvidenceBadge, StatusBadge, type EvidenceBadgeKind } from '@simplexd/ui';
import type { RankedMarketDto, RecommendationResponse } from '@simplexd/contracts';
import { AVAILABILITY_LABELS, statusSummary } from '@/lib/explorer';

const icons = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: CircleDashed,
} as const;

/** Ranking status as icon plus words (never colour alone). */
export function MarketStatusPill({
  ranked,
  recommendation,
}: {
  ranked: RankedMarketDto | null;
  recommendation: Pick<RecommendationResponse, 'rankingEnabled' | 'rankingDisabledReason'> | null;
}) {
  const summary = statusSummary(ranked, recommendation);
  const Icon = icons[summary.tone];
  return (
    <Badge tone={summary.tone}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {summary.label}
    </Badge>
  );
}

/** Service availability: separate from map coverage. */
export function AvailabilityBadge({ availability }: { availability: string }) {
  return <StatusBadge status={availability} label={AVAILABILITY_LABELS[availability] ?? availability} />;
}

/** The distinct evidence badges present for a market; never a single generic "Verified". */
export function EvidenceBadgeRow({
  badges,
  max = 4,
  className,
}: {
  badges: readonly EvidenceBadgeKind[];
  max?: number;
  className?: string;
}) {
  const unique = [...new Set(badges)];
  if (unique.length === 0) return null;
  const shown = unique.slice(0, max);
  const more = unique.length - shown.length;
  return (
    <ul className={className ?? 'flex flex-wrap gap-1'} aria-label="Evidence badges">
      {shown.map((kind) => (
        <li key={kind}>
          <EvidenceBadge kind={kind} showDescription />
        </li>
      ))}
      {more > 0 ? (
        <li className="text-xs text-fg-muted" aria-label={`${more} more evidence badges`}>
          +{more}
        </li>
      ) : null}
    </ul>
  );
}

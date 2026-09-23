import { EvidenceBadge, evidenceBadgeMeta, type EvidenceBadgeKind } from '@simplexd/ui';
import { EVIDENCE_STATEMENTS } from './defaults';

export interface EvidenceStandardItem {
  badge: EvidenceBadgeKind;
  title: string;
  descriptionHtml: string;
}

const ORDER: EvidenceBadgeKind[] = [
  'sourced_observation',
  'verified_operational_record',
  'regional_context',
  'model_estimate',
  'user_assumption',
  'unknown',
  'stale',
  'disputed',
];

/** Default, factual description of the eight badges from the design system. */
export function defaultEvidenceStandards(): EvidenceStandardItem[] {
  return ORDER.map((badge) => ({
    badge,
    title: evidenceBadgeMeta[badge].label,
    descriptionHtml: `<p>${evidenceBadgeMeta[badge].description}</p>`,
  }));
}

export function EvidenceStandards({ items }: { items: EvidenceStandardItem[] }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.badge} className="rounded-lg border border-border bg-bg-elevated p-4">
            <EvidenceBadge kind={item.badge} />
            <h3 className="mt-2 text-sm font-semibold">{item.title}</h3>
            <div
              className="sx-prose mt-1 text-sm text-fg-muted"
              dangerouslySetInnerHTML={{ __html: item.descriptionHtml }}
            />
          </li>
        ))}
      </ul>
      <aside className="rounded-lg border border-border bg-bg-sunken p-4" aria-label="Evidence rules">
        <h3 className="text-sm font-semibold">Rules applied to every figure</h3>
        <ul className="mt-2 space-y-2 text-sm text-fg-muted">
          {EVIDENCE_STATEMENTS.map((s) => (
            <li key={s} className="flex gap-2">
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

import Link from 'next/link';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@simplexd/ui';
import { PLANNED_SECTIONS } from '../_lib/navigation';

const WAVE_NAMES: Record<number, string> = {
  2: 'Wave 2: eight service workflows, customer/staff/partner portals, uploads, budgets, reports and approvals',
  3: 'Wave 3: payments/ledger, SMS, SMTP, Calendar/Meet, admin configuration and operational logs',
  4: 'Wave 4: tenders, procurement, rentals, maintenance and expansion workflow templates',
};

/** Honest placeholder for sections scheduled in a later release wave: no dead controls. */
export function PlannedSection({ sectionKey }: { sectionKey: string }) {
  const section = PLANNED_SECTIONS[sectionKey];
  if (!section) return null;
  return (
    <div className="space-y-6">
      <PageHeader title={section.title} eyebrow={`Planned · release wave ${section.wave}`} />
      <Alert tone="info" title={`This section is delivered in release wave ${section.wave}`}>
        {WAVE_NAMES[section.wave] ?? `Release wave ${section.wave}`}. Nothing here is hidden behind
        a feature flag; the workflows have not been built yet.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>What arrives with this section</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-fg-muted">{section.summary}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/implementation-status">
              <Button variant="secondary">Read IMPLEMENTATION-STATUS.md</Button>
            </Link>
            {section.related?.map((r) => (
              <Link key={r.href} href={r.href}>
                <Button variant="ghost">{r.label}</Button>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

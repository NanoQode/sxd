import type { Metadata } from 'next';
import { Alert, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { PUBLICATION_STATES, humanize } from '../_lib/params';

export const metadata: Metadata = { title: 'Export' };
export const dynamic = 'force-dynamic';

const kinds = [
  {
    kind: 'markets',
    title: 'Markets',
    description:
      'Every market with state, coordinates and coordinate source, publication and availability, import fingerprint dates and version.',
  },
  {
    kind: 'observations',
    title: 'Observations',
    description:
      'Immutable observations with the current interpretation, review and publication state, rank eligibility and full source provenance (license, use notes, retrieval dates).',
  },
] as const;

export default async function ExportsPage() {
  await requireStaffPage('market_data.read_drafts');
  return (
    <div className="space-y-4">
      <PageHeader
        title="Export"
        description="Downloads carry source references so figures can be traced; each export is recorded in the audit log."
      />
      <Alert tone="info">
        Exports include drafts. Respect each source&apos;s license and use notes before
        redistributing.
      </Alert>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {kinds.map((k) => (
          <Card key={k.kind}>
            <CardHeader>
              <CardTitle>{k.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-fg-muted">{k.description}</p>
              <ul className="space-y-1">
                <li>
                  <a
                    className="text-primary underline"
                    href={`/api/v1/admin/exports/${k.kind}.csv`}
                  >
                    All as CSV
                  </a>{' '}
                  ·{' '}
                  <a
                    className="text-primary underline"
                    href={`/api/v1/admin/exports/${k.kind}.json`}
                  >
                    All as JSON
                  </a>
                </li>
                {PUBLICATION_STATES.map((s) => (
                  <li key={s} className="text-fg-muted">
                    {humanize(s)} only:{' '}
                    <a
                      className="text-primary underline"
                      href={`/api/v1/admin/exports/${k.kind}.csv?publicationState=${s}`}
                    >
                      CSV
                    </a>{' '}
                    ·{' '}
                    <a
                      className="text-primary underline"
                      href={`/api/v1/admin/exports/${k.kind}.json?publicationState=${s}`}
                    >
                      JSON
                    </a>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

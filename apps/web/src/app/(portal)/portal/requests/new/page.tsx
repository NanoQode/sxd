import type { Metadata } from 'next';
import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { listScenarios } from '@/server/portal/lists';
import { listIntakeServices } from '@/server/requests/services';
import { RequestForm } from './request-form';

export const metadata: Metadata = { title: 'New request' };
export const dynamic = 'force-dynamic';

export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string; scenario?: string }>;
}) {
  const identity = await requireSignedIn('/portal/requests/new');
  const params = await searchParams;
  if (!identity.ctx.organizationId) {
    return (
      <div className="space-y-4">
        <PageHeader title="New request" />
        <Alert tone="warning" title="An organisation is required">
          Service requests belong to a customer organisation so household members and advisers can share them.{' '}
          <Link href="/onboarding?next=/portal/requests/new" className="font-medium text-primary underline">
            Set one up now
          </Link>
          .
        </Alert>
      </div>
    );
  }
  const [services, scenarios, markets] = await Promise.all([
    listIntakeServices(identity),
    listScenarios(identity),
    withActor(getDb(), identity.ctx, (tx) =>
      tx
        .select({ id: schema.markets.id, name: schema.markets.name, stateName: schema.states.name })
        .from(schema.markets)
        .innerJoin(schema.states, eq(schema.states.id, schema.markets.stateId))
        .where(eq(schema.markets.publicationState, 'published'))
        .orderBy(asc(schema.markets.displayOrder), asc(schema.markets.name)),
    ),
  ]);
  const preselectedScenario = scenarios.find((s) => s.id === params.scenario) ?? null;
  return (
    <div className="space-y-6">
      <PageHeader
        title="New request"
        description="Choose a service, tell us about the property or brief, and we will triage it and reply with a scoped quotation."
      />
      {preselectedScenario ? (
        <Alert tone="info" title={`Starting from scenario “${preselectedScenario.name}”`}>
          The scenario stays linked to this request so the team sees your compared markets and assumptions.
        </Alert>
      ) : null}
      <RequestForm
        services={services}
        markets={markets.map((m) => ({ id: m.id, label: `${m.name}, ${m.stateName}` }))}
        scenarios={scenarios.filter((s) => !s.convertedServiceRequestId).map((s) => ({ id: s.id, name: s.name }))}
        initialServiceSlug={params.service ?? null}
        initialScenarioId={preselectedScenario?.id ?? null}
      />
    </div>
  );
}

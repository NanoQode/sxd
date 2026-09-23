import type { Metadata } from 'next';
import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { PageHeader } from '@simplexd/ui';
import { getDb, schema, withActor } from '@simplexd/db';
import { requireSignedIn } from '@/lib/auth/session';
import { customerCapabilities } from '@/lib/portal/server/permissions';
import { SavedSearchesManager } from '@/components/portal/saved-searches';
import { listSavedSearches } from '@/server/search/saved-searches';

export const metadata: Metadata = { title: 'Saved searches' };
export const dynamic = 'force-dynamic';

export default async function SavedSearchesPage() {
  const identity = await requireSignedIn('/portal/searches');
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity);
  const [searches, places] = await Promise.all([
    listSavedSearches(identity),
    withActor(getDb(), identity.ctx, async (tx) => ({
      markets: await tx
        .select({ id: schema.markets.id, name: schema.markets.name })
        .from(schema.markets)
        .where(eq(schema.markets.publicationState, 'published'))
        .orderBy(asc(schema.markets.name)),
      states: await tx
        .select({ id: schema.states.id, name: schema.states.name })
        .from(schema.states)
        .orderBy(asc(schema.states.name)),
    })),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/requests" className="underline">
            Requests
          </Link>
        }
        title="Saved searches and alerts"
        description="Your search criteria, a preview of today's published matches and alerts for new listings. Only what a listing discloses is compared; nothing is estimated."
      />
      <SavedSearchesManager
        searches={searches}
        markets={places.markets}
        states={places.states}
        zone={zone}
        canManage={caps.can('org.scenarios.manage')}
        cannotManageReason="Saving searches needs an owner or member of this organisation."
      />
    </div>
  );
}

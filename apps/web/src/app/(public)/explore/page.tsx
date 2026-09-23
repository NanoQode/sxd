import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { getIdentity } from '@/lib/auth/session';
import { LocationExplorer } from '@/components/explorer';
import { explorerAccessFor } from '@/components/explorer/access';

export const metadata: Metadata = {
  title: 'Explore locations',
  description:
    'Explore fifty Nigerian property markets across all 36 states and the FCT: evidence badges, filters, side-by-side comparison and assumption-driven scenario calculators.',
  alternates: { canonical: '/explore' },
};

export default async function ExplorePage() {
  const identity = await getIdentity();
  return (
    <div className="sx-container py-8">
      <PageHeader
        eyebrow="Nigeria location explorer"
        title="Explore where to build"
        description="Filter fifty markets, compare up to four side by side, adjust scoring priorities and model your own scenario. Every figure carries its evidence badge; unknown data stays unknown and calculators are scenarios, not valuations."
      />
      <div className="mt-6">
        <LocationExplorer variant="full" access={explorerAccessFor(identity)} />
      </div>
    </div>
  );
}

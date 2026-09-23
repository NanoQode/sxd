import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { can } from '@/lib/admin/server/context';
import { Section } from '@/components/admin/section';
import { RentRunForm } from './rent-run-form';

export const metadata: Metadata = { title: 'Rent invoicing run' };
export const dynamic = 'force-dynamic';

export default async function RentRunPage() {
  const identity = await requireSignedIn('/admin/rentals/rent-run');
  const allowed = can(identity, 'rentals.manage');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Rent invoicing run"
        description="The hourly job issues deposit invoices once and one rent invoice per period due within the lead window, applies lease lifecycle changes (expiring, ended) and expires lapsed tenant invitations. Run it now after activating leases or changing charges; it is safe to repeat."
      />
      <Section title="Run now">
        {allowed ? (
          <RentRunForm />
        ) : (
          <p className="text-fg-muted">Running the job needs rentals.manage.</p>
        )}
      </Section>
    </div>
  );
}

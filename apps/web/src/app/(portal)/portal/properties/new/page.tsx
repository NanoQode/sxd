import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, CardContent, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { PropertyForm } from '@/components/portal/property-form';

export const metadata: Metadata = { title: 'Add a property' };
export const dynamic = 'force-dynamic';

export default async function NewPropertyPage() {
  const identity = await requireSignedIn('/portal/properties/new');
  const caps = customerCapabilities(identity);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/properties" className="underline">
            Properties
          </Link>
        }
        title="Add a property"
        description="Record what you know. Areas are stored exactly as declared (plots are never converted), and title status stays unknown until documents are verified."
      />
      {!caps.organizationId ? (
        <Alert tone="warning" title="No organisation">Create or join an organisation before adding properties.</Alert>
      ) : !caps.manageProperties ? (
        <Alert tone="info" title="Not available for your role">{capabilityNote(caps, 'Adding a property')}</Alert>
      ) : (
        <Card>
          <CardContent className="pt-5">
            <PropertyForm property={null} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

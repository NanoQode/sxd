import type { Metadata } from 'next';
import Link from 'next/link';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { lagosToday } from '@/lib/services/price-anchors';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { listPriceAnchors } from '@/server/admin/configuration/pricing';
import { listConfigServices } from '@/server/admin/configuration/shared';
import { PriceAnchorsBoard } from './_components/price-anchors-board';

export const metadata: Metadata = { title: 'Price anchors' };
export const dynamic = 'force-dynamic';

export default async function PriceAnchorsPage() {
  const identity = await requireSignedIn('/admin/services');
  const ctx = adminContext(identity);
  const canManage = hasStaffPermission(identity.actor, 'pricing.manage');
  const loaded = await attempt(() => listPriceAnchors(ctx));
  const services = canManage ? await listConfigServices(ctx) : [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Price anchors"
        description="Editable starting prices per service (brief §2): basis, minimum scope, exclusions and effective date. Changes are proposed as revisions and published by a different pricing manager; the public site reads only published anchors in force today."
        actions={
          <Link href="/pricing" className="text-sm text-primary underline">
            Public pricing page
          </Link>
        }
      />
      {!canManage ? (
        <Alert tone="info" title="Read-only">
          Proposing, publishing and retiring anchors needs pricing.manage; publishing also needs a
          verified authenticator.
        </Alert>
      ) : null}
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="Price anchors" />
      ) : (
        <PriceAnchorsBoard
          items={loaded.value}
          services={services}
          canManage={canManage}
          mfaVerified={identity.actor.mfaVerified}
          userId={identity.session!.user.id}
          today={lagosToday()}
        />
      )}
    </div>
  );
}

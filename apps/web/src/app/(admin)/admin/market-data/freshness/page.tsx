import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listFreshnessPolicies } from '@/server/admin/market-data/policies';
import { FreshnessEditor } from './freshness-editor';

export const metadata: Metadata = { title: 'Freshness policies' };
export const dynamic = 'force-dynamic';

export default async function FreshnessPage() {
  const identity = await requireStaffPage('market_data.read_drafts');
  const items = await listFreshnessPolicies(adminContext(identity));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Freshness policies"
        description="Maximum age per data type. Stale records remain inspectable but are excluded from default ranking. An official report's own validity takes precedence when 'respect source validity' is on."
      />
      <Alert tone="info">
        Freshness is computed from observation and publication dates, never from import time.
      </Alert>
      <FreshnessEditor
        items={items}
        canManage={
          hasStaffPermission(identity.actor, 'market_data.policy.manage') &&
          identity.actor.mfaVerified
        }
      />
    </div>
  );
}

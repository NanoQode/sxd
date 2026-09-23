import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listRankingPolicies } from '@/server/admin/market-data/policies';
import { PoliciesList } from './policies-list';

export const metadata: Metadata = { title: 'Ranking policies' };
export const dynamic = 'force-dynamic';

export default async function RankingPoliciesPage() {
  const identity = await requireStaffPage('market_data.read_drafts');
  const items = await listRankingPolicies(adminContext(identity));
  const canManage = hasStaffPermission(identity.actor, 'market_data.policy.manage');
  return (
    <div className="space-y-4">
      <PageHeader title="Ranking policies" description="Deterministic, versioned weights, bounds and confidence rubric. Saved recommendations record the version they used; activating a new version never rewrites old reports." />
      {!canManage ? <Alert tone="info">Editing and activation need market_data.policy.manage with a verified authenticator.</Alert> : null}
      <PoliciesList items={items} canManage={canManage && identity.actor.mfaVerified} />
    </div>
  );
}

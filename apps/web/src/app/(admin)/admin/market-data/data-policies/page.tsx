import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listDataPolicies, rankEligibleEvidenceCount } from '@/server/admin/market-data/policies';
import { DataPoliciesEditor } from './data-policies-editor';

export const metadata: Metadata = { title: 'Data policy settings' };
export const dynamic = 'force-dynamic';

export default async function DataPoliciesPage() {
  const identity = await requireStaffPage('market_data.read_drafts');
  const ctx = adminContext(identity);
  const [items, rankEligible] = await Promise.all([listDataPolicies(ctx), rankEligibleEvidenceCount(ctx)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Data policy settings" description="Publication and ranking rules that apply across all markets. Changes are audited and invalidate public caches." />
      <DataPoliciesEditor items={items} rankEligibleEvidence={rankEligible} canManage={hasStaffPermission(identity.actor, 'market_data.policy.manage') && identity.actor.mfaVerified} />
    </div>
  );
}

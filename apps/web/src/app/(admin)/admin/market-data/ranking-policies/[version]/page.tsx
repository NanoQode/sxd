import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError } from '@simplexd/contracts';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { getRankingPolicy } from '@/server/admin/market-data/policies';
import { PolicyEditor } from './policy-editor';

export const metadata: Metadata = { title: 'Ranking policy' };
export const dynamic = 'force-dynamic';

export default async function RankingPolicyPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const identity = await requireStaffPage('market_data.read_drafts');
  const v = Number(version);
  if (!Number.isInteger(v)) notFound();
  let policy;
  try {
    policy = await getRankingPolicy(adminContext(identity), v);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found') notFound();
    throw err;
  }
  const canManage =
    hasStaffPermission(identity.actor, 'market_data.policy.manage') && identity.actor.mfaVerified;
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Policy v${policy.version}: ${policy.name}`}
        eyebrow={policy.status}
        description="Bounds are fixed per version and never change with the map viewport. Equal or invalid bounds disable a metric with an error and block activation."
      />
      <PolicyEditor policy={policy} canManage={canManage} />
    </div>
  );
}

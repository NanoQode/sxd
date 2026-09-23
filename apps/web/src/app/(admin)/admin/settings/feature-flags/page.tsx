import type { Metadata } from 'next';
import { PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { listFeatureFlags } from '@/server/admin/platform/feature-flags';
import { FeatureFlagsManager } from './feature-flags-manager';

export const metadata: Metadata = { title: 'Feature flags' };
export const dynamic = 'force-dynamic';

export default async function FeatureFlagsPage() {
  const identity = await requireStaffPage('platform.feature_flags.manage');
  const items = await listFeatureFlags(adminContext(identity));
  return (
    <div className="space-y-4">
      <PageHeader title="Feature flags" description="Expansion workflows stay off until staffed. Regulated features are gated behind review and can only be enabled by typing the flag key." />
      <FeatureFlagsManager items={items} />
    </div>
  );
}

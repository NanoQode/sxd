import type { Metadata } from 'next';
import { hasStaffPermission } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { adminContext } from '@/server/admin/context';
import { listConfigServices } from '@/server/admin/configuration/shared';
import { listSlaPolicies } from '@/server/admin/configuration/sla-policies';
import { SlaPoliciesEditor } from './sla-policies-editor';

export const metadata: Metadata = { title: 'SLA policies' };
export const dynamic = 'force-dynamic';

export default async function SlaPoliciesPage() {
  const identity = await requireSignedIn('/admin/services/sla-policies');
  const ctx = adminContext(identity);
  const canManage = hasStaffPermission(identity.actor, 'sla.manage');
  const loaded = await attempt(() => listSlaPolicies(ctx));
  const services = await listConfigServices(ctx);
  return (
    <div className="space-y-4">
      <PageHeader
        title="SLA policies"
        description="Target hours per engagement stage, for one service or for every service. The service-specific policy wins over the global one."
      />
      <Alert tone="info" title="What is applied automatically today">
        Triage sets a request’s SLA due time from the active <strong>triage</strong> policy (unless
        the triager types an explicit due time). Targets for the other stages are stored and shown
        in queues and analytics; an escalation job that re-times each stage and notifies the
        escalation role is not built yet, so “escalate to” is recorded but not acted on.
      </Alert>
      {!canManage ? (
        <Alert tone="info" title="Read-only">
          Adding and editing policies needs sla.manage.
        </Alert>
      ) : null}
      {!loaded.ok ? (
        <LoadError code={loaded.code} message={loaded.message} what="SLA policies" />
      ) : (
        <SlaPoliciesEditor items={loaded.value} services={services} canManage={canManage} />
      )}
    </div>
  );
}

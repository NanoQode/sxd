import type { Metadata } from 'next';
import { STAFF_ROLE_DESCRIPTIONS } from '@simplexd/domain/authz';
import { Alert, PageHeader } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { listStaffUsers } from '@/server/admin/access/staff-roles';
import { adminContext } from '@/server/admin/context';
import { StaffRolesManager } from './staff-roles-manager';

export const metadata: Metadata = { title: 'Access' };
export const dynamic = 'force-dynamic';

export default async function AccessPage() {
  const identity = await requireStaffPage('access.staff_roles.manage');
  const users = await listStaffUsers(adminContext(identity), { limit: 500 });
  return (
    <div className="space-y-4">
      <PageHeader title="Access: staff roles" description="Granular permissions come from roles; resource relationships (assignments, grants) apply on top. Grants and revocations are audited." />
      {!identity.actor.mfaVerified ? <Alert tone="warning">Granting or revoking roles requires a verified authenticator.</Alert> : null}
      <StaffRolesManager users={users} actorId={identity.session!.user.id} roleDescriptions={STAFF_ROLE_DESCRIPTIONS} canManage={identity.actor.mfaVerified} />
    </div>
  );
}

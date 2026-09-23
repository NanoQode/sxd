import { staffDirectoryQuerySchema, staffRoleChangeSchema } from '@simplexd/contracts';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { changeStaffRole, listStaffUsers } from '@/server/admin/access/staff-roles';
import { requireAdminContext } from '@/server/admin/http';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/staff-roles?q= — staff members with roles, or users matching q (access.staff_roles.manage). */
export const GET = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const query = parseQuery(req, staffDirectoryQuerySchema);
  return json({ items: await listStaffUsers(ctx, query) }, { correlationId });
});

/** POST /api/v1/admin/staff-roles — grant or revoke a role with a reason (access.staff_roles.manage, MFA). */
export const POST = route(async (req, { correlationId }) => {
  const ctx = await requireAdminContext(correlationId);
  const body = await parseJson(req, staffRoleChangeSchema);
  return json(await changeStaffRole(ctx, body), { correlationId });
});

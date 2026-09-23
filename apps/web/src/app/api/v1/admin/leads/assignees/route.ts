import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { listStaffAssignees } from '@/server/leads/admin';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/leads/assignees — users holding an active staff role. */
export const GET = route(async (_req, { correlationId }) => {
  const identity = await requireStaff('leads.read');
  return json({ items: await listStaffAssignees(identity) }, { correlationId });
});

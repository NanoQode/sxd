import { getDb } from '@simplexd/db';
import { providerStatus } from '@simplexd/notifications';
import { requireStaff } from '@/lib/auth/session';
import { json, route } from '@/lib/api/respond';
import { pipelineOptions } from '../_lib';

export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/notifications/providers — SMTP/Termii state (configured, unverified, connected) without secrets. */
export const GET = route(async (_req, { correlationId }) => {
  await requireStaff('integrations.read');
  return json({ items: await providerStatus(getDb(), pipelineOptions()) }, { correlationId });
});

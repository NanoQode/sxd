import { z } from 'zod';
import { notificationChannelSchema, templateKeySchema } from '@simplexd/contracts';
import { requireStaff } from '@/lib/auth/session';
import { json, params, parseQuery, route } from '@/lib/api/respond';
import '@/lib/api/registry/communications';
import { adminContext } from '@/server/admin/context';
import { templateFamily } from '@/server/admin/communications/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/notifications/templates/families/:key/:channel — every
 * version (history), the active one, the variable reference with sample
 * values and, for SMS, the per-segment price used for estimates.
 */
export const GET = route<{ params: Promise<{ key: string; channel: string }> }>(
  async (req, ctx) => {
    const identity = await requireStaff('notifications.templates.manage');
    const { key, channel } = await params(
      ctx,
      z.object({ key: templateKeySchema, channel: notificationChannelSchema }),
    );
    const { locale } = parseQuery(req, z.object({ locale: z.string().min(2).max(16).optional() }));
    const detail = await templateFamily(adminContext(identity, ctx.correlationId), {
      key,
      channel,
      locale,
    });
    return json(detail, { correlationId: ctx.correlationId });
  },
);

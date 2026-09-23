import 'server-only';
import { eq } from 'drizzle-orm';
import {
  ApiError,
  type NotificationPreferenceItem,
  type NotificationPreferencesDto,
  type NotificationPreferencesUpdate,
} from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { isValidTimeZone } from '@simplexd/domain/time';
import type { RequestIdentity } from '@/lib/auth/session';

const CHANNELS = ['email', 'sms', 'in_app'] as const;
const CATEGORIES = ['security', 'transactional', 'reminders', 'digests', 'marketing'] as const;
/** Essential security messages follow product policy and cannot be disabled. */
const LOCKED = ['security'] as const;

function defaultEnabled(channel: (typeof CHANNELS)[number], category: (typeof CATEGORIES)[number]): boolean {
  if (category === 'marketing') return false;
  if (channel === 'sms') return category === 'security' || category === 'transactional';
  return true;
}

function toHhmm(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 5);
}

/** Full channel x category matrix; missing rows fall back to policy defaults. */
export async function getNotificationPreferences(identity: RequestIdentity): Promise<NotificationPreferencesDto> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  const { rows, quietDefault } = await withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId));
    const [setting] = await tx
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, 'notifications.quiet_hours'));
    return { rows, quietDefault: (setting?.value as { start?: string; end?: string } | undefined) ?? null };
  });
  const byKey = new Map(rows.map((r) => [`${r.channel}:${r.category}`, r]));
  const items: NotificationPreferenceItem[] = [];
  for (const channel of CHANNELS) {
    for (const category of CATEGORIES) {
      const row = byKey.get(`${channel}:${category}`);
      items.push({
        channel,
        category,
        enabled: (LOCKED as readonly string[]).includes(category) ? true : (row?.enabled ?? defaultEnabled(channel, category)),
        digest: row?.digest ?? 'none',
      });
    }
  }
  const withQuiet = rows.find((r) => r.quietHoursStart && r.quietHoursEnd);
  const quietHours = withQuiet
    ? { start: toHhmm(withQuiet.quietHoursStart)!, end: toHhmm(withQuiet.quietHoursEnd)! }
    : rows.length === 0 && quietDefault?.start && quietDefault.end
      ? { start: quietDefault.start, end: quietDefault.end }
      : null;
  return {
    items,
    quietHours,
    timeZone: rows.find((r) => r.timeZone)?.timeZone ?? identity.profile?.timeZone ?? null,
    lockedCategories: [...LOCKED],
  };
}

export async function updateNotificationPreferences(
  identity: RequestIdentity,
  input: NotificationPreferencesUpdate,
): Promise<NotificationPreferencesDto> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const userId = identity.session.user.id;
  if (input.timeZone && !isValidTimeZone(input.timeZone)) {
    throw new ApiError('validation_failed', 'unknown time zone', { details: [{ path: 'timeZone' }] });
  }
  const timeZone = input.timeZone ?? identity.profile?.timeZone ?? 'Africa/Lagos';
  await withActor(getDb(), identity.ctx, async (tx) => {
    for (const item of input.items) {
      const locked = (LOCKED as readonly string[]).includes(item.category);
      const values = {
        userId,
        channel: item.channel,
        category: item.category,
        enabled: locked ? true : item.enabled,
        digest: item.digest,
        quietHoursStart: input.quietHours?.start ?? null,
        quietHoursEnd: input.quietHours?.end ?? null,
        timeZone,
      };
      await tx
        .insert(schema.notificationPreferences)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.notificationPreferences.userId,
            schema.notificationPreferences.channel,
            schema.notificationPreferences.category,
          ],
          set: {
            enabled: values.enabled,
            digest: values.digest,
            quietHoursStart: values.quietHoursStart,
            quietHoursEnd: values.quietHoursEnd,
            timeZone,
          },
        });
    }
  });
  return getNotificationPreferences(identity);
}

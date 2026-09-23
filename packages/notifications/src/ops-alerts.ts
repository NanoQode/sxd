import { schema, type DbExecutor } from '@simplexd/db';
import type { PipelineEnv } from './env';
import { staffWithRoles } from './recipients';
import type { NotificationChannel, NotificationRequest } from './types';

/**
 * Operational alerts (brief §19): the worker's monitoring snapshot emits an
 * `ops.alert` outbox event when a threshold is crossed (queue lag, dead jobs,
 * stuck outbox, webhook failures, failed calendar syncs, storage/scanner
 * errors, low SMS balance, overdue reviews and SLA items), at most once per
 * alert key per hour. This resolver sends it to the staff roles named on the
 * event with the generic `activity_update` template. Payloads carry counts
 * and thresholds only, never personal data.
 */

type StaffRole = (typeof schema.staffRoleEnum.enumValues)[number];

const STAFF_ROLES: ReadonlySet<string> = new Set(schema.staffRoleEnum.enumValues);
const DEFAULT_ROLES: StaffRole[] = ['super_admin'];
const CHANNELS: NotificationChannel[] = ['email', 'in_app'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export interface OpsAlertPayload {
  key: string;
  severity: 'warning' | 'critical';
  title: string;
  message: string;
  /** Admin path the alert links to; anything outside /admin falls back to the operations page. */
  linkPath: string;
  roles: StaffRole[];
  value: number;
  threshold: number;
  /** Start of the hour the alert was raised in (ISO), the deduplication window. */
  window: string;
}

export function opsAlertRoles(value: unknown): StaffRole[] {
  const roles = Array.isArray(value)
    ? value.filter((r): r is StaffRole => typeof r === 'string' && STAFF_ROLES.has(r))
    : [];
  return roles.length > 0 ? [...new Set(roles)] : DEFAULT_ROLES;
}

export async function resolveOpsAlert(ctx: {
  tx: DbExecutor;
  event: { aggregateId: string; correlationId?: string | null };
  payload: Record<string, unknown>;
  env: PipelineEnv;
  scope: string;
}): Promise<NotificationRequest[]> {
  const { tx, event, payload, env, scope } = ctx;
  const recipients = await staffWithRoles(tx, opsAlertRoles(payload['roles']));
  if (recipients.length === 0) return [];
  const link = str(payload['linkPath']);
  const linkPath = link && /^\/admin(\/|$)/.test(link) ? link : '/admin/operations';
  const severity = payload['severity'] === 'critical' ? 'Critical' : 'Warning';
  return [
    {
      templateKey: 'activity_update',
      category: 'transactional',
      channels: CHANNELS,
      recipients,
      variables: {
        title: `${severity}: ${str(payload['title']) ?? 'Operational alert'}`,
        message: str(payload['message']) ?? 'A monitoring threshold was crossed.',
        linkUrl: `${env.appUrl}${linkPath}`,
      },
      dedupeScope: scope,
      inApp: { linkPath },
      relatedEntity: { type: 'ops_alert', id: null },
      organizationId: null,
      correlationId: event.correlationId ?? null,
    },
  ];
}

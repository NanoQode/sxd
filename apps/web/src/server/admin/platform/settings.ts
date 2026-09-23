import 'server-only';
import { asc, eq, inArray } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { settingDefaults } from '@simplexd/db/seed';
import { isValidTimeZone } from '@simplexd/domain/time';
import { recordAudit } from '@/lib/audit';
import { actorId, assertUpdatedAt, authorize, transact, type AdminContext } from '../context';

export type SettingType = 'string' | 'boolean' | 'integer' | 'number' | 'string_list' | 'time_range' | 'enum';

export interface SettingDefinition {
  key: string;
  type: SettingType;
  description: string;
  options?: string[];
  min?: number;
  max?: number;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whitelisted, typed settings. Only keys seeded in reference data can be edited. */
export const SETTING_DEFINITIONS: Record<string, Omit<SettingDefinition, 'key' | 'description'>> = {
  'brand.name': { type: 'string', max: 80 },
  'brand.tagline': { type: 'string', max: 200 },
  'brand.theme_default': { type: 'enum', options: ['system', 'light', 'dark'] },
  'brand.assets_approved': { type: 'boolean' },
  'business.time_zone': { type: 'string', max: 64 },
  'uploads.max_bytes': { type: 'integer', min: 1_048_576, max: 10_737_418_240 },
  'uploads.allowed_mime': { type: 'string_list', max: 60 },
  'retention.evidence_years': { type: 'integer', min: 1, max: 30 },
  'retention.analytics_days': { type: 'integer', min: 1, max: 3650 },
  'publication.min_comparables': { type: 'integer', min: 1, max: 1000 },
  'ranking.coverage_threshold': { type: 'number', min: 0, max: 1 },
  'notifications.quiet_hours': { type: 'time_range' },
  'security.staff_mfa_required': { type: 'boolean' },
  'analytics.consent_version': { type: 'string', max: 32 },
};

export function settingDefinitions(): SettingDefinition[] {
  return settingDefaults
    .filter((s) => SETTING_DEFINITIONS[s.key])
    .map((s) => ({ key: s.key, description: s.description, ...SETTING_DEFINITIONS[s.key]! }));
}

export function validateSettingValue(key: string, value: unknown): string | null {
  const def = SETTING_DEFINITIONS[key];
  if (!def) return 'unknown setting';
  switch (def.type) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
      if (def.max && value.length > def.max) return `must be at most ${def.max} characters`;
      if (key === 'business.time_zone' && !isValidTimeZone(value)) return 'unknown IANA time zone';
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be an integer';
      if (def.min !== undefined && value < def.min) return `must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be at most ${def.max}`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (def.min !== undefined && value < def.min) return `must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be at most ${def.max}`;
      return null;
    case 'string_list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === ''))
        return 'must be a list of non-empty strings';
      if (def.max && value.length > def.max) return `at most ${def.max} entries`;
      if (key === 'uploads.allowed_mime' && value.some((v: string) => /svg|html|javascript|x-sh/i.test(v)))
        return 'SVG, HTML and script MIME types are never allowed';
      return null;
    case 'time_range': {
      const v = value as { start?: unknown; end?: unknown } | null;
      if (!v || typeof v !== 'object') return 'must be an object with start and end (HH:MM)';
      if (typeof v.start !== 'string' || !TIME.test(v.start)) return 'start must be HH:MM';
      if (typeof v.end !== 'string' || !TIME.test(v.end)) return 'end must be HH:MM';
      return null;
    }
    case 'enum':
      return typeof value === 'string' && def.options?.includes(value) ? null : `must be one of ${def.options?.join(', ')}`;
  }
}

export interface SettingDto extends SettingDefinition {
  value: unknown;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function listSettings(ctx: AdminContext): Promise<SettingDto[]> {
  authorize(ctx, 'platform.settings.manage');
  const defs = settingDefinitions();
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.settings)
      .where(inArray(schema.settings.key, defs.map((d) => d.key)))
      .orderBy(asc(schema.settings.key));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return defs.map((d) => {
      const r = byKey.get(d.key);
      const seeded = settingDefaults.find((s) => s.key === d.key);
      return {
        ...d,
        value: r ? r.value : (seeded?.value ?? null),
        updatedBy: r?.updatedBy ?? null,
        updatedAt: r ? r.updatedAt.toISOString() : null,
      };
    });
  });
}

export async function patchSetting(
  ctx: AdminContext,
  key: string,
  input: { value: unknown; reason?: string; expectedUpdatedAt?: string },
): Promise<SettingDto> {
  authorize(ctx, 'platform.settings.manage');
  const def = settingDefinitions().find((d) => d.key === key);
  if (!def) throw new ApiError('not_found', `setting ${key} is not editable here`);
  const problem = validateSettingValue(key, input.value);
  if (problem) throw new ApiError('validation_failed', `${key} ${problem}`, { details: [{ path: 'value', message: problem }] });
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    const existing = await tx.select().from(schema.settings).where(eq(schema.settings.key, key));
    const current = existing[0];
    if (current) assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    const [row] = await tx
      .insert(schema.settings)
      .values({ key, value: input.value as object, description: def.description, updatedBy: userId })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: input.value as object, updatedBy: userId, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: 'setting.updated',
      entityType: 'setting',
      entityId: key,
      before: { value: current?.value ?? null },
      after: { value: input.value },
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    return { ...def, value: row!.value, updatedBy: row!.updatedBy, updatedAt: row!.updatedAt.toISOString() };
  });
}

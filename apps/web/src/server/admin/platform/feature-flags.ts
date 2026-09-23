import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import {
  actorId,
  assertUpdatedAt,
  authorize,
  notFound,
  transact,
  type AdminContext,
} from '../context';

type FlagRow = typeof schema.featureFlags.$inferSelect;

export interface FeatureFlagDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: FlagRow['category'];
  enabled: boolean;
  rollout: FlagRow['rollout'];
  requiresReview: boolean;
  reviewNote: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

const toDto = (r: FlagRow): FeatureFlagDto => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  category: r.category,
  enabled: r.enabled,
  rollout: r.rollout,
  requiresReview: r.requiresReview,
  reviewNote: r.reviewNote,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

export async function listFeatureFlags(ctx: AdminContext): Promise<FeatureFlagDto[]> {
  authorize(ctx, 'platform.feature_flags.manage');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.featureFlags)
      .orderBy(asc(schema.featureFlags.category), asc(schema.featureFlags.key));
    return rows.map(toDto);
  });
}

/**
 * Toggles a flag. Flags that require review need a reason; regulated flags
 * can only be enabled by typing the key back, so an activation is never a
 * single accidental click.
 */
export async function patchFeatureFlag(
  ctx: AdminContext,
  key: string,
  input: { enabled: boolean; reason?: string; confirmKey?: string; expectedUpdatedAt?: string },
): Promise<FeatureFlagDto> {
  authorize(ctx, 'platform.feature_flags.manage');
  const userId = actorId(ctx);
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, key));
    const current = rows[0];
    if (!current) throw notFound('feature flag');
    assertUpdatedAt(current.updatedAt, input.expectedUpdatedAt);
    if (current.enabled === input.enabled) return toDto(current);
    if (current.requiresReview && !input.reason?.trim())
      throw new ApiError(
        'validation_failed',
        'this flag requires a review note explaining the change',
        {
          details: [{ path: 'reason', message: 'required' }],
        },
      );
    if (current.category === 'regulated_gated' && input.enabled && input.confirmKey !== key)
      throw new ApiError(
        'validation_failed',
        `regulated feature ${key} can only be enabled by typing its key exactly; ${current.reviewNote ?? 'it requires operating model, providers and professional review'}`,
        { details: [{ path: 'confirmKey', message: 'must match the flag key' }] },
      );
    const [updated] = await tx
      .update(schema.featureFlags)
      .set({ enabled: input.enabled, updatedBy: userId })
      .where(eq(schema.featureFlags.id, current.id))
      .returning();
    await recordAudit(tx, ctx.identity, {
      action: input.enabled ? 'feature_flag.enabled' : 'feature_flag.disabled',
      entityType: 'feature_flag',
      entityId: key,
      before: { enabled: current.enabled },
      after: { enabled: updated!.enabled, category: current.category },
      reason: input.reason ?? null,
      correlationId: ctx.correlationId,
    });
    return toDto(updated!);
  });
}

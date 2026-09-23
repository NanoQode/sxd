import { ApiError } from '@simplexd/contracts';
import { applyActorContext, systemContext, type ActorContext, type Transaction } from '@simplexd/db';
import {
  anonymousActor,
  assertAllowed,
  authorizeAny,
  authorizeOrg,
  authorizeStaff,
  type Actor,
  type OrgPermission,
  type ResourceRef,
  type StaffPermission,
} from '@simplexd/domain/authz';
import type { ActorKind } from '@simplexd/domain/workflow';

/**
 * Who is calling the finance orchestration. Carries both the authorization
 * actor (permissions, memberships, MFA state) and the row-level security
 * context so every read proves access and every privileged write happens
 * only after an explicit authorization decision.
 */
export interface FinanceActor {
  actor: Actor;
  ctx: ActorContext;
  correlationId?: string;
  ipHash?: string | null;
  userAgent?: string | null;
}

export function systemFinanceActor(correlationId?: string): FinanceActor {
  return {
    actor: { ...anonymousActor, userId: null },
    ctx: systemContext(correlationId),
    ...(correlationId ? { correlationId } : {}),
  };
}

export function isSystemActor(fa: FinanceActor): boolean {
  return Boolean(fa.ctx.bypass) && !fa.actor.userId;
}

export function isStaffActor(fa: FinanceActor): boolean {
  return fa.actor.staffRoles.length > 0;
}

export function actorKindOf(fa: FinanceActor): ActorKind {
  if (isSystemActor(fa)) return 'system';
  if (isStaffActor(fa)) return 'staff';
  if (fa.actor.isPartner) return 'partner';
  return 'customer';
}

export function requireUserId(fa: FinanceActor): string {
  if (!fa.actor.userId) throw new ApiError('unauthenticated', 'sign in required');
  return fa.actor.userId;
}

export function assertStaff(
  fa: FinanceActor,
  permission: StaffPermission,
  resource?: ResourceRef,
): void {
  if (isSystemActor(fa)) return;
  if (!fa.actor.userId) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeStaff(fa.actor, permission, resource));
}

export function assertOrg(fa: FinanceActor, permission: OrgPermission, resource: ResourceRef): void {
  if (!fa.actor.userId) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeOrg(fa.actor, permission, resource));
}

/** Allows staff with the staff permission or a member with the organisation permission. */
export function assertStaffOrOrg(
  fa: FinanceActor,
  staff: StaffPermission,
  org: OrgPermission,
  resource: ResourceRef,
): void {
  if (isSystemActor(fa)) return;
  if (!fa.actor.userId) throw new ApiError('unauthenticated', 'sign in required');
  assertAllowed(authorizeAny(fa.actor, [{ staff }, { org }], resource));
}

/**
 * Runs `fn` with the transaction temporarily elevated to the system context
 * (journals, provider events, sequences), then restores the caller's own
 * context so later statements are policy-checked again. Callers authorise the
 * action before elevating.
 */
export async function elevated<T>(
  tx: Transaction,
  fa: FinanceActor,
  fn: () => Promise<T>,
): Promise<T> {
  if (fa.ctx.bypass) return fn();
  await applyActorContext(tx, { ...fa.ctx, bypass: true });
  try {
    return await fn();
  } finally {
    await applyActorContext(tx, { ...fa.ctx, bypass: false });
  }
}

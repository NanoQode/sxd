import 'server-only';
import { ApiError } from '@simplexd/contracts';
import { getDb } from '@simplexd/db';
import { createFinanceRuntime, type FinanceActor, type FinanceRuntime } from '@simplexd/finance';
import { getIdentity, type RequestIdentity } from '@/lib/auth/session';
import { clientIp, hashIp } from '@/lib/rate-limit';

/**
 * Web adapter for @simplexd/finance: one runtime per process and a
 * FinanceActor derived from the request identity. Routes stay thin; every
 * authorization decision and database write lives in the package.
 */

const cache = globalThis as unknown as { __simplexdFinanceRuntime?: FinanceRuntime };

export function getFinanceRuntime(): FinanceRuntime {
  if (!cache.__simplexdFinanceRuntime) {
    cache.__simplexdFinanceRuntime = createFinanceRuntime({ db: getDb() });
  }
  return cache.__simplexdFinanceRuntime;
}

export function financeActorFrom(
  identity: RequestIdentity,
  req: Request,
  correlationId: string,
): FinanceActor {
  return {
    actor: identity.actor,
    ctx: { ...identity.ctx, correlationId },
    correlationId,
    ipHash: hashIp(clientIp(req)),
    userAgent: req.headers.get('user-agent'),
  };
}

export interface FinanceRequestContext {
  rt: FinanceRuntime;
  fa: FinanceActor;
  identity: RequestIdentity;
}

/** Signed-in caller required; permissions are checked by the finance functions themselves. */
export async function financeContext(
  req: Request,
  correlationId: string,
): Promise<FinanceRequestContext> {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  return { rt: getFinanceRuntime(), fa: financeActorFrom(identity, req, correlationId), identity };
}

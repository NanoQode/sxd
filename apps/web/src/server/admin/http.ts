import 'server-only';
import { z } from 'zod';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { adminContext, type AdminContext } from './context';

/** Resolves the admin context for a route handler; fine-grained permissions are checked by each server function. */
export async function requireAdminContext(correlationId: string): Promise<AdminContext> {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  if (identity.actor.staffRoles.length === 0)
    throw new ApiError('forbidden', 'staff access required');
  return adminContext(identity, correlationId);
}

export const idParams = z.object({ id: uuidSchema });
export const marketChildParams = (child: string) =>
  z.object({ id: uuidSchema, [child]: uuidSchema });
export const keyParams = z.object({ key: z.string().min(1).max(120) });

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, route } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  purpose: z.enum([
    'privacy_notice',
    'marketing_email',
    'marketing_sms',
    'analytics',
    'identity_documents',
    'screening',
  ]),
  granted: z.boolean(),
  source: z.string().max(64).default('portal'),
  policyVersion: z.string().max(32).default('2026-09'),
});

/** Append-only consent record for the signed-in user. */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, bodySchema);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const ipHash = ip ? createHash('sha256').update(ip).digest('hex').slice(0, 32) : null;
  const row = await withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .insert(schema.consents)
      .values({
        userId: identity.session!.user.id,
        subjectEmail: identity.session!.user.email,
        purpose: body.purpose,
        granted: body.granted,
        policyVersion: body.policyVersion,
        source: body.source,
        ipHash,
      })
      .returning({ id: schema.consents.id, recordedAt: schema.consents.recordedAt });
    return rows[0];
  });
  return json(row, { status: 201, correlationId });
});

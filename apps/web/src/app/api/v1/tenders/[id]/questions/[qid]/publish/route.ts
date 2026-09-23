import { getIdentity } from '@/lib/auth/session';
import { json, params, route } from '@/lib/api/respond';
import { tenderQuestionParams } from '@/lib/api/registry/commercial';
import { publishTenderAnswer } from '@/server/tenders/questions';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; qid: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id, qid } = await params(ctx, tenderQuestionParams);
  return json(await publishTenderAnswer(identity, id, qid, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});

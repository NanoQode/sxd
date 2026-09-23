import { tenderQuestionAnswerSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { tenderQuestionParams } from '@/lib/api/registry/commercial';
import { answerTenderQuestion } from '@/server/tenders/questions';

export const dynamic = 'force-dynamic';

export const POST = route<{ params: Promise<{ id: string; qid: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id, qid } = await params(ctx, tenderQuestionParams);
  const body = await parseJson(req, tenderQuestionAnswerSchema);
  return json(await answerTenderQuestion(identity, id, qid, body, { correlationId: ctx.correlationId }), { correlationId: ctx.correlationId });
});

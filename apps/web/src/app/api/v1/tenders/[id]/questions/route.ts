import { tenderQuestionAskSchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, params, parseJson, route } from '@/lib/api/respond';
import { commercialIdParams } from '@/lib/api/registry/commercial';
import { askTenderQuestion, listTenderQuestions } from '@/server/tenders/questions';

export const dynamic = 'force-dynamic';

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  return json(
    { items: await listTenderQuestions(identity, id, { correlationId: ctx.correlationId }) },
    { correlationId: ctx.correlationId },
  );
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const identity = await getIdentity();
  const { id } = await params(ctx, commercialIdParams);
  const body = await parseJson(req, tenderQuestionAskSchema);
  return json(await askTenderQuestion(identity, id, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});

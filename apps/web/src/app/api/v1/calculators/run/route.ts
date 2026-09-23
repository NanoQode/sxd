import { calculatorRunRequestSchema } from '@simplexd/contracts';
import { json, parseJson, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { runCalculatorSuite } from '@/server/markets/calculators';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** POST /api/v1/calculators/run: pure calculation, no persistence, no identity needed. */
export const POST = route(async (req, { correlationId }) => {
  await enforceRateLimit(`calculators:${hashIp(clientIp(req))}`, { windowSeconds: 60, max: 120 });
  const body = await parseJson(req, calculatorRunRequestSchema);
  return json(runCalculatorSuite(body, new Date()), { correlationId });
});

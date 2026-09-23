import { scenarioCreateSchema, scenarioListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { clientIp, enforceRateLimit, hashIp } from '@/lib/rate-limit';
import { createScenario, listScenarios } from '@/server/markets/scenarios';
import '@/lib/api/registry/markets';

export const dynamic = 'force-dynamic';

/** GET /api/v1/scenarios: my scenarios (account-owned or held by the anonymous cookie token). */
export const GET = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  const query = parseQuery(req, scenarioListQuerySchema);
  return json(await listScenarios(query, identity), { correlationId });
});

/** POST /api/v1/scenarios */
export const POST = route(async (req, { correlationId }) => {
  const identity = await getIdentity();
  await enforceRateLimit(`scenarios:create:${identity.ctx.userId ?? hashIp(clientIp(req))}`, {
    windowSeconds: 60,
    max: 30,
  });
  const body = await parseJson(req, scenarioCreateSchema);
  const scenario = await createScenario(body, identity, correlationId);
  return json(scenario, { status: 201, correlationId });
});

import { projectCreateSchema, projectListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createProject, listProjects } from '@/server/projects/projects';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  const query = parseQuery(req, projectListQuerySchema);
  return json(await listProjects(identity, query), { status: 200, correlationId: ctx.correlationId });
});

export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  const body = await parseJson(req, projectCreateSchema);
  return json(await createProject(identity, body, { correlationId: ctx.correlationId }), { status: 201, correlationId: ctx.correlationId });
});

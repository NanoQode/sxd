import { ApiError, entityNoteCreateSchema, entityNoteListQuerySchema } from '@simplexd/contracts';
import { getIdentity } from '@/lib/auth/session';
import { json, parseJson, parseQuery, route } from '@/lib/api/respond';
import { createNote, listNotes } from '@/server/notes/service';
import '@/lib/api/registry/collaboration';

export const dynamic = 'force-dynamic';

/** GET /api/v1/notes?entityType=&entityId= — notes the caller may see on one entity. */
export const GET = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const query = parseQuery(req, entityNoteListQuerySchema);
  return json(await listNotes(identity, query), { correlationId: ctx.correlationId });
});

/** POST /api/v1/notes — append a note with an explicit visibility. */
export const POST = route(async (req, ctx) => {
  const identity = await getIdentity();
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const body = await parseJson(req, entityNoteCreateSchema);
  return json(await createNote(identity, body, { correlationId: ctx.correlationId }), {
    status: 201,
    correlationId: ctx.correlationId,
  });
});

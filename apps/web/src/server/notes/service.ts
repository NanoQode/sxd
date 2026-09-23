import 'server-only';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  ApiError,
  type EntityNoteCreate,
  type EntityNoteDto,
  type EntityNoteListQuery,
  type Page,
  type Visibility,
} from '@simplexd/contracts';
import { getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeOrg, authorizePartner } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  ENTITY_STAFF_READ,
  classifyViewer,
  entityResourceRef,
  resolveEntity,
  type EntityAccess,
  type ViewerClass,
} from '@/server/assignments/access';
import {
  actorContext,
  decodeCursor,
  elevate,
  encodeCursor,
  isStaffIdentity,
  requireUserId,
  userNameMap,
  type ServiceOptions,
} from '@/server/assignments/shared';

type NoteRow = typeof schema.notes.$inferSelect;

/**
 * Append-only notes on operational entities. There is no update or delete:
 * a correction is a new note. Every note carries an explicit visibility and
 * authorisation is derived from the parent entity:
 *  - staff see everything they can read;
 *  - customers see `customer` and `all` notes on their organisation's entities;
 *  - partners see `partner` and `all` notes on entities they are assigned to.
 * `internal` notes never leave the staff.
 */

const CREATABLE_BY: Record<ViewerClass, Visibility[]> = {
  staff: ['internal', 'customer', 'partner', 'all'],
  customer: ['customer', 'all'],
  assignee: ['partner', 'all'],
};

const READABLE_BY: Record<Exclude<ViewerClass, 'staff'>, Visibility[]> = {
  customer: ['customer', 'all'],
  assignee: ['partner', 'all'],
};

function toDto(row: NoteRow, names: Map<string, string>): EntityNoteDto {
  return {
    id: row.id,
    entityType: row.entityType as EntityNoteDto['entityType'],
    entityId: row.entityId,
    organizationId: row.organizationId,
    body: row.body,
    visibility: row.visibility,
    authorUserId: row.authorUserId,
    authorName: names.get(row.authorUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toDtos(tx: DbExecutor, rows: NoteRow[]): Promise<EntityNoteDto[]> {
  const names = await userNameMap(
    tx,
    rows.map((r) => r.authorUserId),
  );
  return rows.map((r) => toDto(r, names));
}

interface EntityViewer {
  entity: EntityAccess;
  viewer: ViewerClass;
}

async function requireEntityViewer(
  tx: DbExecutor,
  identity: RequestIdentity,
  entityType: EntityNoteCreate['entityType'],
  entityId: string,
): Promise<EntityViewer> {
  const entity = await resolveEntity(tx, entityType, entityId);
  if (!entity) throw new ApiError('not_found', `${entityType.replace('_', ' ')} not found`);
  const ref = await entityResourceRef(tx, identity, entity);
  const viewer = classifyViewer(identity, entity, ref, ENTITY_STAFF_READ[entityType]);
  if (!viewer) throw new ApiError('forbidden', 'you do not have access to this resource');
  return { entity, viewer };
}

export async function createNote(
  identity: RequestIdentity,
  input: EntityNoteCreate,
  options: ServiceOptions = {},
): Promise<EntityNoteDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  return withActor(getDb(), ctx, async (tx) => {
    const { entity, viewer } = await requireEntityViewer(tx, identity, input.entityType, input.entityId);
    // Staff attached only through an assignment (e.g. an inspector) may still write internal notes.
    const effective: ViewerClass = viewer === 'assignee' && isStaffIdentity(identity) ? 'staff' : viewer;
    if (effective === 'customer') {
      assertAllowed(
        authorizeOrg(identity.actor, 'org.comment', {
          type: entity.type,
          id: entity.id,
          organizationId: entity.organizationId,
        }),
      );
    } else if (effective === 'assignee') {
      assertAllowed(
        authorizePartner(identity.actor, 'partner.assignments.view', {
          type: entity.type,
          id: entity.id,
          assigneeUserIds: entity.assigneeUserIds,
        }),
      );
    }
    if (!CREATABLE_BY[effective].includes(input.visibility)) {
      throw new ApiError('forbidden', `you may not create ${input.visibility} notes on this ${entity.type.replace('_', ' ')}`, {
        details: { allowedVisibility: CREATABLE_BY[effective] },
      });
    }
    const [row] = await tx
      .insert(schema.notes)
      .values({
        organizationId: entity.organizationId,
        entityType: input.entityType,
        entityId: input.entityId,
        body: input.body,
        visibility: input.visibility,
        authorUserId: userId,
      })
      .returning();
    await recordAudit(tx, identity, {
      action: 'note.created',
      entityType: input.entityType,
      entityId: input.entityId,
      organizationId: entity.organizationId,
      after: { noteId: row!.id, visibility: input.visibility },
      correlationId: options.correlationId,
    });
    const [dto] = await toDtos(tx, [row!]);
    return dto!;
  });
}

export async function listNotes(
  identity: RequestIdentity,
  query: EntityNoteListQuery,
): Promise<Page<EntityNoteDto>> {
  const userId = requireUserId(identity);
  return withActor(getDb(), identity.ctx, async (tx) => {
    const { viewer } = await requireEntityViewer(tx, identity, query.entityType, query.entityId);
    if (viewer === 'assignee' && !isStaffIdentity(identity)) {
      // The notes policy has no assignment clause, so a partner would only see notes they
      // authored. Their accepted/active assignment was proven under their own context above;
      // the explicit visibility filter below keeps internal and customer-only notes out.
      await elevate(tx, identity.ctx);
    }
    const cursor = decodeCursor(query.cursor);
    const rows = await tx
      .select()
      .from(schema.notes)
      .where(
        and(
          eq(schema.notes.entityType, query.entityType),
          eq(schema.notes.entityId, query.entityId),
          viewer === 'staff'
            ? undefined
            : or(
                inArray(schema.notes.visibility, READABLE_BY[viewer]),
                eq(schema.notes.authorUserId, userId),
              ),
          cursor
            ? or(
                lt(schema.notes.createdAt, cursor.createdAt),
                and(eq(schema.notes.createdAt, cursor.createdAt), lt(schema.notes.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.notes.createdAt), desc(schema.notes.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items: await toDtos(tx, page), nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
  });
}

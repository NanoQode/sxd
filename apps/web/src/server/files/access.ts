import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { applyActorContext, schema, type ActorContext, type Transaction } from '@simplexd/db';
import {
  AuthorizationError,
  authorizeOrg,
  authorizeStaff,
  type Actor,
  type Decision,
  type Membership,
  type OrgRole,
} from '@simplexd/domain/authz';
import type { RequestIdentity } from '@/lib/auth/session';
import {
  isSensitivePurpose,
  isStaffIdentity,
  notFound,
  type FileGrantRow,
  type FileRow,
} from './shared';

/**
 * File access policy. Every decision is made against rows read in the same
 * transaction: the caller's organisation memberships are re-read from `member`
 * on every call (never taken from the session), so a revoked membership
 * denies fresh access immediately, and the file's grants are read with their
 * revocation and expiry columns.
 *
 * Levels:
 * - `view`     list/metadata and derivative variants (thumb/web);
 * - `download` the original object;
 * - `manage`   grants and public approval (owner or staff only).
 */

export type FileAccessLevel = 'view' | 'download' | 'manage';

export interface FileAccessContext {
  file: FileRow;
  /** Active (not revoked, not expired) grants that apply to this user or their current organisations. */
  grants: FileGrantRow[];
  /** Fresh memberships read from the database in this transaction. */
  memberships: Membership[];
  /**
   * For partner submission files: true once a bid revision that references the
   * file belongs to a bid whose sealed contents were opened by an evaluator.
   */
  openedSubmission?: boolean;
}

function normalizeOrgRole(role: string): OrgRole {
  const known: OrgRole[] = ['owner', 'member', 'adviser', 'approver', 'tenant'];
  if ((known as string[]).includes(role)) return role as OrgRole;
  if (role === 'admin') return 'owner';
  return 'member';
}

/** Re-reads the user's organisation memberships (no caching, by design). */
export async function freshMemberships(tx: Transaction, userId: string): Promise<Membership[]> {
  const rows = await tx
    .select({ organizationId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  return rows.map((m) => ({ organizationId: m.organizationId, role: normalizeOrgRole(m.role) }));
}

/**
 * Runs `fn` with the transaction elevated (bypass) and restores the caller's
 * context afterwards. Reserved for what the row policies cannot express:
 * - the access-proving read: memberships are re-read from `member` instead of
 *   trusting the session's organisation (`app.org_id()`), and organisation
 *   grants are matched against those fresh memberships;
 * - listing/revoking grants as the file owner when staff created them (the
 *   grants policy lets only the grantor or staff write a grant).
 * Every decision (`decideFileAccess`) runs before the write it authorises.
 */
export async function elevated<T>(
  tx: Transaction,
  ctx: ActorContext,
  fn: () => Promise<T>,
): Promise<T> {
  await applyActorContext(tx, { ...ctx, bypass: true });
  try {
    return await fn();
  } finally {
    await applyActorContext(tx, { ...ctx, bypass: false });
  }
}

/** Loads the file, the caller's fresh memberships and the applicable grants (elevated read). */
export async function loadFileAccess(
  tx: Transaction,
  ctx: ActorContext,
  fileId: string,
): Promise<FileAccessContext | null> {
  return elevated(tx, ctx, async () => {
    const [file] = await tx
      .select()
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, fileId));
    if (!file || file.deletedAt) return null;
    const memberships = ctx.userId ? await freshMemberships(tx, ctx.userId) : [];
    const now = Date.now();
    const rows = await tx
      .select()
      .from(schema.fileAccessGrants)
      .where(
        and(eq(schema.fileAccessGrants.fileId, fileId), isNull(schema.fileAccessGrants.revokedAt)),
      );
    const orgIds = new Set(memberships.map((m) => m.organizationId));
    const grants = rows.filter(
      (g) =>
        (!g.expiresAt || g.expiresAt.getTime() > now) &&
        ((g.userId !== null && g.userId === ctx.userId) ||
          (g.organizationId !== null && orgIds.has(g.organizationId))),
    );
    let openedSubmission = false;
    if (file.purpose === 'partner_submission') {
      const opened = await tx.execute<{ opened: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM bid_revisions br JOIN bids b ON b.id = br.bid_id
          WHERE b.opened_at IS NOT NULL
            AND br.attachment_file_ids @> jsonb_build_array(${fileId}::text)
        ) AS opened
      `);
      openedSubmission = Boolean(opened.rows[0]?.opened);
    }
    return { file, grants, memberships, openedSubmission };
  });
}

const GRANT_RANK = { view: 1, download: 2 } as const;

function deny(reason: string): Decision {
  return { allowed: false, code: 'no_permission', reason };
}

/** Pure policy over rows loaded by `loadFileAccess`. */
export function decideFileAccess(
  identity: RequestIdentity,
  access: FileAccessContext,
  level: FileAccessLevel,
): Decision {
  const userId = identity.actor.userId;
  if (!userId) return { allowed: false, code: 'unauthenticated', reason: 'sign in required' };
  const { file, grants, memberships } = access;
  if (file.deletedAt) return deny('the file was deleted');
  if (file.ownerUserId === userId) return { allowed: true, via: 'owner' };
  const sensitive = isSensitivePurpose(file.purpose);
  if (isStaffIdentity(identity)) {
    const decision = authorizeStaff(identity.actor, 'files.read_all', {
      type: 'file',
      id: file.id,
      organizationId: file.organizationId,
      createdBy: file.ownerUserId,
      attributes: { sensitive },
    });
    if (decision.allowed) return decision;
    // Evaluators read a partner's bid attachments only after the sealed bid was opened.
    if (file.purpose === 'partner_submission' && access.openedSubmission && level !== 'manage') {
      for (const permission of ['bids.evaluate', 'tenders.manage'] as const) {
        const d = authorizeStaff(identity.actor, permission, { type: 'bid', id: file.id });
        if (d.allowed) return { allowed: true, via: `opened_bid:${permission}` };
      }
    }
    // Staff without file permissions fall through to grants; never to org membership.
    if (level === 'manage') return decision;
    const grant = bestGrant(grants);
    if (grant && GRANT_RANK[grant] >= GRANT_RANK[level])
      return { allowed: true, via: `grant:${grant}` };
    return decision;
  }
  if (level === 'manage') return deny('only the file owner or staff can manage access');
  // Explicit grants (user grants, or organisation grants for a current member).
  const grant = bestGrant(grants);
  if (grant && GRANT_RANK[grant] >= GRANT_RANK[level])
    return { allowed: true, via: `grant:${grant}` };
  if (sensitive)
    return deny('sensitive documents are available to their owner and authorised staff only');
  if (!file.organizationId) return deny('the file is not shared with you');
  // Organisation membership, evaluated against the membership rows read just now.
  const actor: Actor = {
    ...identity.actor,
    memberships,
    activeOrganizationId: file.organizationId,
  };
  const decision = authorizeOrg(actor, 'org.documents.view', {
    type: 'file',
    id: file.id,
    organizationId: file.organizationId,
  });
  if (decision.allowed) return decision;
  if (grants.length > 0) return deny('your access grant does not allow this action');
  return decision;
}

function bestGrant(grants: FileGrantRow[]): 'view' | 'download' | null {
  let best: 'view' | 'download' | null = null;
  for (const g of grants) {
    if (g.level === 'download') return 'download';
    best = 'view';
  }
  return best;
}

/**
 * Loads and authorises in one step. Files the caller cannot see at all
 * answer "not found" so ids are not enumerable; files the caller can see but
 * not use at the requested level answer "forbidden".
 */
export async function requireFileAccess(
  tx: Transaction,
  identity: RequestIdentity,
  ctx: ActorContext,
  fileId: string,
  level: FileAccessLevel,
): Promise<FileAccessContext> {
  const access = await loadFileAccess(tx, ctx, fileId);
  if (!access) throw notFound();
  const decision = decideFileAccess(identity, access, level);
  if (!decision.allowed) {
    const visible = decideFileAccess(identity, access, 'view').allowed;
    if (!visible) throw notFound();
    if (decision.code === 'unauthenticated')
      throw new ApiError('unauthenticated', 'sign in required');
    throw new AuthorizationError(decision);
  }
  return access;
}

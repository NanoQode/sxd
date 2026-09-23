import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiError,
  type LeadDto,
  type ListingApprove,
  type ListingDetailDto,
  type ListingMarkDuplicate,
  type ListingReason,
  type VerificationCheckCreate,
} from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { assertAllowed, authorizeStaff } from '@simplexd/domain/authz';
import { evaluateTransition, listingMachine, type ListingState } from '@simplexd/domain/workflow';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { actorContext, requireUserId, type ServiceOptions } from '@/server/assignments/shared';
import { assertListingVersion, requireListing, requireRevision, type ListingRow } from './access';
import { authorityRequiredError, buildListingDetail, currentVerifiedAuthority } from './owner';
import { invalidatePublicListings } from './public';
import { availabilityExpiry, effectiveListingStatus, readScope, type StoredCheck } from './rules';

/**
 * Staff moderation. Decisions (publish a specific revision, reject, request
 * changes, mark duplicate) need `content.publish`; verification checks need
 * `rentals.manage`. Every decision is audited with before/after state and
 * emits an outbox event the notification registry turns into an owner
 * notification. Publication re-checks the owner authority and requires an
 * explicit approval for exact coordinates.
 */

function assertMachine(from: ListingState, to: ListingState, reason?: string | null): void {
  const result = evaluateTransition(listingMachine, { from, to, actor: 'staff', reason });
  if (!result.ok) {
    throw new ApiError('invalid_transition', result.message, {
      details: { from, to, code: result.code },
    });
  }
}

async function staffName(tx: DbExecutor, userId: string): Promise<string> {
  const [u] = await tx
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return u?.name ? `${u.name} (SimplexD)` : 'SimplexD staff';
}

async function updateVersioned(
  tx: DbExecutor,
  row: ListingRow,
  expectedVersion: number,
  set: Partial<typeof schema.listings.$inferInsert>,
): Promise<ListingRow> {
  const [updated] = await tx
    .update(schema.listings)
    .set({ ...set, version: sql`${schema.listings.version} + 1` })
    .where(and(eq(schema.listings.id, row.id), eq(schema.listings.version, expectedVersion)))
    .returning();
  if (!updated) {
    throw new ApiError('version_conflict', 'the listing changed during the decision; reload it');
  }
  return updated;
}

/** Appends checks to the scopes of the given revisions without rewriting existing ones. */
async function appendChecks(
  tx: DbExecutor,
  listingId: string,
  versions: number[],
  checks: StoredCheck[],
  summary?: string,
): Promise<void> {
  if (versions.length === 0) return;
  const scopeExpr = sql`coalesce(${schema.listingRevisions.verificationScope}, '{"checks":[]}'::jsonb)`;
  const withChecks = sql`jsonb_set(${scopeExpr}, '{checks}', coalesce(${scopeExpr}->'checks', '[]'::jsonb) || ${JSON.stringify(checks)}::jsonb)`;
  const next =
    summary !== undefined
      ? sql`jsonb_set(${withChecks}, '{summary}', to_jsonb(${summary}::text))`
      : withChecks;
  await tx
    .update(schema.listingRevisions)
    .set({ verificationScope: next })
    .where(
      and(
        eq(schema.listingRevisions.listingId, listingId),
        inArray(schema.listingRevisions.version, versions),
      ),
    );
}

async function outbox(
  tx: DbExecutor,
  eventType: string,
  row: ListingRow,
  actorUserId: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<void> {
  await appendOutbox(tx, {
    eventType,
    aggregateType: 'listing',
    aggregateId: row.id,
    organizationId: row.organizationId,
    actorUserId,
    payload: { listingId: row.id, slug: row.slug, ...payload },
    correlationId,
  });
}

/**
 * Publishes one specific revision. The revision must be the current one (a
 * newer save means staff must review that instead), the owner authority must
 * still be verified and unexpired, and a revision asking for exact
 * coordinates needs `approveExactLocation`. Publication starts the
 * availability window and records the owner-authority check on the scope.
 */
export async function approveListing(
  identity: RequestIdentity,
  id: string,
  input: ListingApprove,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'moderate');
    assertListingVersion(row, input.expectedVersion);
    assertMachine(row.status, 'published');
    if (input.revisionVersion !== row.currentVersion) {
      throw new ApiError(
        'version_conflict',
        `revision ${input.revisionVersion} is not the latest; review revision ${row.currentVersion}`,
        { details: { currentVersion: row.currentVersion } },
      );
    }
    const revision = await requireRevision(tx, id, input.revisionVersion);
    if (revision.publicLocationPrecision === 'exact' && !input.approveExactLocation) {
      throw new ApiError(
        'validation_failed',
        'this revision asks to publish exact coordinates; approve that explicitly or request changes',
        { details: [{ path: 'approveExactLocation', message: 'explicit approval required' }] },
      );
    }
    const authority = await currentVerifiedAuthority(tx, row.propertyId, now);
    if (!authority) throw authorityRequiredError();
    // Record what was checked about the authority, by whom and until when (once per authority).
    const scope = readScope(revision.verificationScope);
    const verifiedAt = authority.verifiedAt?.toISOString() ?? now.toISOString();
    const alreadyRecorded = scope.checks.some(
      (c) => c.item === 'owner_authority' && c.checkedAt === verifiedAt,
    );
    if (!alreadyRecorded) {
      await appendChecks(
        tx,
        id,
        [revision.version],
        [
          {
            item: 'owner_authority',
            outcome: 'passed',
            result: `Authority to act for the owner (${authority.ownerName}) was verified against the submitted document.`,
            checkedBy: authority.verifiedBy
              ? await staffName(tx, authority.verifiedBy)
              : 'SimplexD staff',
            checkedByUserId: authority.verifiedBy ?? undefined,
            checkedAt: verifiedAt,
            ...(authority.expiresAt ? { expiresAt: authority.expiresAt.toISOString() } : {}),
            recordedAt: now.toISOString(),
          },
        ],
      );
    }
    const expiresAt = availabilityExpiry(now);
    const updated = await updateVersioned(tx, row, input.expectedVersion, {
      status: 'published',
      publishedVersion: revision.version,
      publishedAt: now,
      publishedBy: userId,
      moderatedBy: userId,
      moderationNote: input.note ?? null,
      ownerAuthorityId: authority.id,
      expiresAt,
      availabilityConfirmedAt: now,
    });
    await recordAudit(tx, identity, {
      action: 'listing.published',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, publishedVersion: row.publishedVersion },
      after: {
        status: 'published',
        publishedVersion: revision.version,
        publicLocationPrecision: revision.publicLocationPrecision,
        exactLocationApproved: revision.publicLocationPrecision === 'exact',
        expiresAt: expiresAt.toISOString(),
        ownerAuthorityId: authority.id,
      },
      reason: input.note ?? null,
      correlationId: options.correlationId,
    });
    await outbox(
      tx,
      'listing.published',
      row,
      userId,
      {
        title: revision.title,
        revisionVersion: revision.version,
        expiresAt: expiresAt.toISOString(),
      },
      options.correlationId,
    );
    return buildListingDetail(tx, identity, updated, now);
  });
  await invalidatePublicListings();
  return result;
}

/**
 * Rejects the submission. A listing that was never published becomes
 * `rejected`; a live listing keeps its approved revision (the newer changes
 * are refused) and returns to `published`.
 */
export async function rejectListing(
  identity: RequestIdentity,
  id: string,
  input: ListingReason,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  return decide(identity, id, input, 'reject', options);
}

/** Sends the submission back for edits: to `draft`, or back to `published` for a live listing. */
export async function requestListingChanges(
  identity: RequestIdentity,
  id: string,
  input: ListingReason,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  return decide(identity, id, input, 'changes', options);
}

async function decide(
  identity: RequestIdentity,
  id: string,
  input: ListingReason,
  decision: 'reject' | 'changes',
  options: ServiceOptions,
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'moderate');
    assertListingVersion(row, input.expectedVersion);
    if (row.status !== 'in_moderation') {
      throw new ApiError('invalid_transition', 'only listings in moderation can be decided');
    }
    const live = row.publishedVersion !== null;
    const to: ListingState = live ? 'published' : decision === 'reject' ? 'rejected' : 'draft';
    assertMachine(row.status, to, input.reason);
    const updated = await updateVersioned(tx, row, input.expectedVersion, {
      status: to,
      moderatedBy: userId,
      moderationNote: input.reason,
    });
    const action = decision === 'reject' ? 'listing.rejected' : 'listing.changes_requested';
    await recordAudit(tx, identity, {
      action,
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status },
      after: { status: to, reviewedRevision: row.currentVersion, staysLive: live },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    const revision = await requireRevision(tx, id, row.currentVersion);
    await outbox(
      tx,
      action,
      row,
      userId,
      { title: revision.title, reason: input.reason, staysLive: live },
      options.correlationId,
    );
    return buildListingDetail(tx, identity, updated);
  });
  await invalidatePublicListings();
  return result;
}

/**
 * Marks a listing as a duplicate of another. The duplicate never shows
 * publicly again (its public URL points to the original while that is live)
 * and cannot be resubmitted.
 */
export async function markListingDuplicate(
  identity: RequestIdentity,
  id: string,
  input: ListingMarkDuplicate,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'moderate');
    assertListingVersion(row, input.expectedVersion);
    if (input.duplicateOfListingId === id) {
      throw new ApiError('validation_failed', 'a listing cannot duplicate itself', {
        details: [{ path: 'duplicateOfListingId', message: 'choose another listing' }],
      });
    }
    const [original] = await tx
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, input.duplicateOfListingId));
    if (!original) throw new ApiError('not_found', 'the original listing was not found');
    if (original.duplicateOfListingId) {
      throw new ApiError(
        'validation_failed',
        'the original is itself a duplicate; point to the listing it duplicates',
        {
          details: [{ path: 'duplicateOfListingId', message: 'choose the original listing' }],
        },
      );
    }
    if (row.duplicateOfListingId) {
      throw new ApiError('invalid_transition', 'already marked as a duplicate');
    }
    const effective = effectiveListingStatus(row.status, row.expiresAt, now);
    const from: ListingState = effective === 'expired' ? 'expired' : row.status;
    const to: ListingState =
      from === 'in_moderation' && row.publishedVersion === null ? 'rejected' : 'withdrawn';
    if (!['in_moderation', 'published', 'paused', 'expired'].includes(from)) {
      throw new ApiError(
        'invalid_transition',
        `a ${from.replace(/_/g, ' ')} listing cannot be marked as a duplicate`,
      );
    }
    assertMachine(from, to, input.reason);
    const note = `Duplicate of ${original.slug}: ${input.reason}`;
    const updated = await updateVersioned(tx, row, input.expectedVersion, {
      status: to,
      duplicateOfListingId: original.id,
      moderatedBy: userId,
      moderationNote: note,
    });
    await recordAudit(tx, identity, {
      action: 'listing.marked_duplicate',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      before: { status: row.status, duplicateOfListingId: null },
      after: { status: to, duplicateOfListingId: original.id },
      reason: input.reason,
      correlationId: options.correlationId,
    });
    const revision = await requireRevision(tx, id, row.currentVersion);
    await outbox(
      tx,
      'listing.marked_duplicate',
      row,
      userId,
      { title: revision.title, reason: note },
      options.correlationId,
    );
    return buildListingDetail(tx, identity, updated, now);
  });
  await invalidatePublicListings();
  return result;
}

/**
 * Records a verification check on the current revision and, when a different
 * revision is live, on the published one too (checks describe the property,
 * not the wording). Checks are appended, never rewritten; a superseding check
 * is recorded as a new entry.
 */
export async function recordVerificationCheck(
  identity: RequestIdentity,
  id: string,
  input: VerificationCheckCreate,
  options: ServiceOptions = {},
): Promise<ListingDetailDto> {
  const userId = requireUserId(identity);
  const ctx = actorContext(identity, options);
  const now = new Date();
  const result = await withActor(getDb(), ctx, async (tx) => {
    const row = await requireListing(tx, identity, id, 'verify');
    if (row.status === 'archived') {
      throw new ApiError(
        'invalid_transition',
        'closed listings no longer take verification checks',
      );
    }
    const checkedAt = input.checkedAt ? new Date(input.checkedAt) : now;
    if (checkedAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new ApiError('validation_failed', 'a check cannot be dated in the future', {
        details: [{ path: 'checkedAt', message: 'must not be in the future' }],
      });
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= checkedAt.getTime()) {
      throw new ApiError('validation_failed', 'the expiry must be after the check date', {
        details: [{ path: 'expiresAt', message: 'must be after checkedAt' }],
      });
    }
    const check: StoredCheck = {
      item: input.item,
      outcome: input.outcome,
      result: input.result,
      checkedBy: await staffName(tx, userId),
      checkedByUserId: userId,
      checkedAt: checkedAt.toISOString(),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      recordedAt: now.toISOString(),
    };
    const versions = [row.currentVersion];
    if (row.publishedVersion !== null && row.publishedVersion !== row.currentVersion) {
      versions.push(row.publishedVersion);
    }
    await appendChecks(tx, id, versions, [check], input.summary);
    await recordAudit(tx, identity, {
      action: 'listing.verification_check_recorded',
      entityType: 'listing',
      entityId: id,
      organizationId: row.organizationId,
      after: { ...check, checkedByUserId: undefined, revisions: versions },
      correlationId: options.correlationId,
    });
    return buildListingDetail(tx, identity, row, now);
  });
  await invalidatePublicListings();
  return result;
}

/** Inquiries (leads) about a listing, for staff with leads.read. */
export async function listListingInquiries(
  identity: RequestIdentity,
  listingId: string,
): Promise<
  Array<Pick<LeadDto, 'id' | 'contactName' | 'status' | 'createdAt'> & { suspicious: boolean }>
> {
  requireUserId(identity);
  assertAllowed(authorizeStaff(identity.actor, 'leads.read'));
  return withActor(getDb(), identity.ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schema.leads.id,
        contactName: schema.leads.contactName,
        status: schema.leads.status,
        createdAt: schema.leads.createdAt,
        context: schema.leads.context,
      })
      .from(schema.leads)
      .where(sql`${schema.leads.context}->>'listingId' = ${listingId}`)
      .orderBy(sql`${schema.leads.createdAt} desc`)
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      contactName: r.contactName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      suspicious: Boolean((r.context as { suspicious?: boolean } | null)?.suspicious),
    }));
  });
}

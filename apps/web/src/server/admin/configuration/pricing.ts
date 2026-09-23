import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  priceAnchorValuesSchema,
  type PriceAnchorCreate,
  type PriceAnchorDraft,
  type PriceAnchorRetire,
  type PriceAnchorTransition,
  type PriceAnchorValues,
} from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { AuthorizationError } from '@simplexd/domain/authz';
import { recordAudit } from '@/lib/audit';
import { cacheDelete } from '@/lib/cache';
import {
  parseAnchorSnapshot,
  type AnchorSnapshot,
  type AnchorValues,
  type RevisionEvent,
  type RevisionState,
} from '@/lib/services/price-anchors';
import {
  actorId,
  assertVersion,
  authorize,
  changedFields,
  notFound,
  transact,
  versionConflict,
  type AdminContext,
} from '../context';
import { isUniqueViolation, requireVerifiedMfa, userRefs } from './shared';

/**
 * Service price anchors (brief §2). The `service_packages` row holds the live
 * anchor the public site reads; it changes only when a reviewer publishes.
 * Every change is proposed as an append-only `service_package_revisions` row
 * (draft saved → submitted → published / rejected / withdrawn), so history is
 * never overwritten. A proposal is published by a pricing manager who did not
 * author it (separation of duties) with a verified authenticator and a reason.
 *
 * Seeded anchors start as `in_review` rows without revisions: they are an
 * implicit proposal awaiting their first business review.
 */

type PackageRow = typeof schema.servicePackages.$inferSelect;
type RevisionRow = typeof schema.servicePackageRevisions.$inferSelect;
type AnchorValuesDto = AnchorValues;

export type { AnchorValues, RevisionEvent, RevisionState };

export interface UserRef {
  id: string;
  name: string;
}

export interface PriceAnchorRevisionDto {
  revision: number;
  event: RevisionEvent;
  state: RevisionState;
  values: AnchorValuesDto;
  reason: string | null;
  changedBy: UserRef | null;
  createdAt: string;
}

export interface PriceAnchorProposal {
  state: 'draft' | 'in_review';
  implicit: boolean;
  values: AnchorValuesDto;
  authors: UserRef[];
  startedAt: string | null;
  updatedAt: string | null;
}

export interface PriceAnchorDto {
  id: string;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  slug: string;
  publicationState: PackageRow['publicationState'];
  version: number;
  live: AnchorValuesDto;
  publishedAt: string | null;
  reviewedBy: UserRef | null;
  reviewedAt: string | null;
  latestRevision: number;
  proposal: PriceAnchorProposal | null;
  revisions?: PriceAnchorRevisionDto[];
}

export function rowValues(row: PackageRow): AnchorValuesDto {
  return {
    name: row.name,
    description: row.description,
    scopeMarkdown: row.scopeMarkdown,
    priceBasis: row.priceBasis,
    amountKobo: row.amountKobo === null ? null : row.amountKobo.toString(),
    percentageBps: row.percentageBps,
    currency: row.currency,
    minimumScope: row.minimumScope,
    exclusions: row.exclusions,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

function valuesFromInput(v: PriceAnchorValues): AnchorValuesDto {
  return {
    name: v.name,
    description: v.description ?? null,
    scopeMarkdown: v.scopeMarkdown ?? null,
    priceBasis: v.priceBasis,
    amountKobo: v.amountKobo ?? null,
    percentageBps: v.percentageBps ?? null,
    currency: v.currency ?? 'NGN',
    minimumScope: v.minimumScope,
    exclusions: v.exclusions,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo ?? null,
  };
}

function columnsFromValues(v: AnchorValuesDto) {
  return {
    name: v.name,
    description: v.description,
    scopeMarkdown: v.scopeMarkdown,
    priceBasis: v.priceBasis,
    amountKobo: v.amountKobo === null ? null : BigInt(v.amountKobo),
    percentageBps: v.percentageBps,
    currency: v.currency,
    minimumScope: v.minimumScope,
    exclusions: v.exclusions,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
  };
}

const parseSnapshot = parseAnchorSnapshot;

interface ParsedRevision {
  row: RevisionRow;
  snapshot: AnchorSnapshot;
}

interface ProposalAnalysis {
  latestRevision: number;
  proposal: (Omit<PriceAnchorProposal, 'authors'> & { authorIds: string[] }) | null;
}

/**
 * Derives the open proposal from the revision log: the revisions after the
 * last terminal event (published, rejected, withdrawn, retired). Authors are
 * everyone who saved or submitted within that chain.
 */
export function analyseProposal(row: PackageRow, revisions: RevisionRow[]): ProposalAnalysis {
  const sorted = [...revisions].sort((a, b) => a.version - b.version);
  const latestRevision = sorted.at(-1)?.version ?? 0;
  const parsed: ParsedRevision[] = [];
  for (const r of sorted) {
    const snapshot = parseSnapshot(r.snapshot);
    if (snapshot) parsed.push({ row: r, snapshot });
  }
  let chain: ParsedRevision[] = [];
  for (const p of parsed) {
    if (p.snapshot.event === 'draft_saved' || p.snapshot.event === 'submitted') chain.push(p);
    else chain = [];
  }
  const last = chain.at(-1);
  if (last) {
    const authorIds = [
      ...new Set(chain.map((c) => c.row.changedBy).filter((v): v is string => Boolean(v))),
    ];
    return {
      latestRevision,
      proposal: {
        state: last.snapshot.event === 'submitted' ? 'in_review' : 'draft',
        implicit: false,
        values: last.snapshot.values,
        authorIds,
        startedAt: chain[0]!.row.createdAt.toISOString(),
        updatedAt: last.row.createdAt.toISOString(),
      },
    };
  }
  if (row.publicationState === 'in_review') {
    return {
      latestRevision,
      proposal: {
        state: 'in_review',
        implicit: true,
        values: rowValues(row),
        authorIds: [
          ...new Set([row.createdBy, row.updatedBy].filter((v): v is string => Boolean(v))),
        ],
        startedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }
  return { latestRevision, proposal: null };
}

async function loadRevisions(tx: Transaction, packageIds: string[]): Promise<RevisionRow[]> {
  if (packageIds.length === 0) return [];
  return tx
    .select()
    .from(schema.servicePackageRevisions)
    .where(inArray(schema.servicePackageRevisions.packageId, packageIds))
    .orderBy(asc(schema.servicePackageRevisions.version));
}

async function buildDtos(
  tx: Transaction,
  rows: Array<{ pkg: PackageRow; service: { id: string; slug: string; name: string } }>,
  withHistory: boolean,
): Promise<PriceAnchorDto[]> {
  const revisions = await loadRevisions(
    tx,
    rows.map((r) => r.pkg.id),
  );
  const byPackage = new Map<string, RevisionRow[]>();
  for (const r of revisions) {
    const list = byPackage.get(r.packageId) ?? [];
    list.push(r);
    byPackage.set(r.packageId, list);
  }
  const analyses = rows.map((r) => analyseProposal(r.pkg, byPackage.get(r.pkg.id) ?? []));
  const users = await userRefs(tx, [
    ...rows.map((r) => r.pkg.reviewedBy),
    ...analyses.flatMap((a) => a.proposal?.authorIds ?? []),
    ...(withHistory ? revisions.map((r) => r.changedBy) : []),
  ]);
  const ref = (id: string | null | undefined): UserRef | null =>
    id ? (users.get(id) ?? { id, name: id }) : null;
  return rows.map((r, i) => {
    const analysis = analyses[i]!;
    const history = withHistory
      ? (byPackage.get(r.pkg.id) ?? [])
          .map((rev) => ({ rev, snapshot: parseSnapshot(rev.snapshot) }))
          .filter((x): x is { rev: RevisionRow; snapshot: AnchorSnapshot } => x.snapshot !== null)
          .map(({ rev, snapshot }) => ({
            revision: rev.version,
            event: snapshot.event,
            state: snapshot.state,
            values: snapshot.values,
            reason: rev.reason,
            changedBy: ref(rev.changedBy),
            createdAt: rev.createdAt.toISOString(),
          }))
          .reverse()
      : undefined;
    return {
      id: r.pkg.id,
      serviceId: r.service.id,
      serviceSlug: r.service.slug,
      serviceName: r.service.name,
      slug: r.pkg.slug,
      publicationState: r.pkg.publicationState,
      version: r.pkg.version,
      live: rowValues(r.pkg),
      publishedAt: r.pkg.publishedAt?.toISOString() ?? null,
      reviewedBy: ref(r.pkg.reviewedBy),
      reviewedAt: r.pkg.reviewedAt?.toISOString() ?? null,
      latestRevision: analysis.latestRevision,
      proposal: analysis.proposal
        ? {
            state: analysis.proposal.state,
            implicit: analysis.proposal.implicit,
            values: analysis.proposal.values,
            authors: analysis.proposal.authorIds.map((id) => ref(id)!),
            startedAt: analysis.proposal.startedAt,
            updatedAt: analysis.proposal.updatedAt,
          }
        : null,
      ...(history ? { revisions: history } : {}),
    };
  });
}

const packageSelect = {
  pkg: schema.servicePackages,
  service: { id: schema.services.id, slug: schema.services.slug, name: schema.services.name },
};

/** Every package with its live anchor and open proposal (`pricing.manage`). */
export async function listPriceAnchors(ctx: AdminContext): Promise<PriceAnchorDto[]> {
  authorize(ctx, 'pricing.manage');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select(packageSelect)
      .from(schema.servicePackages)
      .innerJoin(schema.services, eq(schema.services.id, schema.servicePackages.serviceId))
      .orderBy(
        asc(schema.services.category),
        asc(schema.services.sortOrder),
        asc(schema.servicePackages.name),
      );
    return buildDtos(tx, rows, false);
  });
}

/** One package with its full revision history (newest first). */
export async function getPriceAnchor(ctx: AdminContext, id: string): Promise<PriceAnchorDto> {
  authorize(ctx, 'pricing.manage');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select(packageSelect)
      .from(schema.servicePackages)
      .innerJoin(schema.services, eq(schema.services.id, schema.servicePackages.serviceId))
      .where(eq(schema.servicePackages.id, id));
    if (!rows[0]) throw notFound('price anchor');
    return (await buildDtos(tx, rows, true))[0]!;
  });
}

/** Services a new package can be attached to (id, name, category). */
export async function listPricingServices(
  ctx: AdminContext,
): Promise<Array<{ id: string; slug: string; name: string; category: string }>> {
  authorize(ctx, 'pricing.manage');
  return transact(ctx, (tx) =>
    tx
      .select({
        id: schema.services.id,
        slug: schema.services.slug,
        name: schema.services.name,
        category: schema.services.category,
      })
      .from(schema.services)
      .orderBy(asc(schema.services.category), asc(schema.services.sortOrder)),
  );
}

async function loadPackageForUpdate(tx: Transaction, id: string) {
  const rows = await tx
    .select()
    .from(schema.servicePackages)
    .where(eq(schema.servicePackages.id, id))
    .for('update');
  const pkg = rows[0];
  if (!pkg) throw notFound('price anchor');
  const revisions = await loadRevisions(tx, [id]);
  return { pkg, revisions, analysis: analyseProposal(pkg, revisions) };
}

async function appendRevision(
  tx: Transaction,
  packageId: string,
  revision: number,
  snapshot: AnchorSnapshot,
  reason: string | null,
  userId: string,
): Promise<void> {
  try {
    await tx.insert(schema.servicePackageRevisions).values({
      packageId,
      version: revision,
      snapshot,
      reason,
      changedBy: userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw versionConflict(revision - 1);
    throw err;
  }
}

function assertRevision(latest: number, expected: number): void {
  if (latest !== expected) throw versionConflict(latest);
}

async function reload(tx: Transaction, id: string): Promise<PriceAnchorDto> {
  const rows = await tx
    .select(packageSelect)
    .from(schema.servicePackages)
    .innerJoin(schema.services, eq(schema.services.id, schema.servicePackages.serviceId))
    .where(eq(schema.servicePackages.id, id));
  return (await buildDtos(tx, rows, true))[0]!;
}

/** Public catalogue caches read published anchors; publication and retirement clear them. */
async function clearPublicCaches(): Promise<void> {
  await cacheDelete('services:');
}

/** Adds a package to a service as an unpublished draft proposal. */
export async function createPriceAnchor(
  ctx: AdminContext,
  input: PriceAnchorCreate,
): Promise<PriceAnchorDto> {
  authorize(ctx, 'pricing.manage');
  const userId = actorId(ctx);
  const values = valuesFromInput(priceAnchorValuesSchema.parse(input.values));
  return transact(ctx, async (tx) => {
    const [service] = await tx
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(eq(schema.services.id, input.serviceId));
    if (!service) throw notFound('service');
    const dup = await tx
      .select({ id: schema.servicePackages.id })
      .from(schema.servicePackages)
      .where(
        and(
          eq(schema.servicePackages.serviceId, input.serviceId),
          eq(schema.servicePackages.slug, input.slug),
        ),
      );
    if (dup.length > 0)
      throw new ApiError('conflict', `this service already has a package "${input.slug}"`);
    const [row] = await tx
      .insert(schema.servicePackages)
      .values({
        serviceId: input.serviceId,
        slug: input.slug,
        ...columnsFromValues(values),
        publicationState: 'draft',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    await appendRevision(
      tx,
      row!.id,
      1,
      { kind: 'price_anchor', event: 'draft_saved', state: 'draft', values },
      input.note ?? null,
      userId,
    );
    await recordAudit(tx, ctx.identity, {
      action: 'price_anchor.created',
      entityType: 'service_package',
      entityId: row!.id,
      after: { serviceId: input.serviceId, slug: input.slug, values },
      reason: input.note ?? null,
      correlationId: ctx.correlationId,
    });
    return reload(tx, row!.id);
  });
}

/** Saves a proposed change as a new draft revision; the live anchor is untouched. */
export async function savePriceAnchorDraft(
  ctx: AdminContext,
  id: string,
  input: PriceAnchorDraft,
): Promise<PriceAnchorDto> {
  authorize(ctx, 'pricing.manage');
  const userId = actorId(ctx);
  const values = valuesFromInput(priceAnchorValuesSchema.parse(input.values));
  return transact(ctx, async (tx) => {
    const { pkg, analysis } = await loadPackageForUpdate(tx, id);
    assertRevision(analysis.latestRevision, input.expectedRevision);
    await appendRevision(
      tx,
      pkg.id,
      analysis.latestRevision + 1,
      { kind: 'price_anchor', event: 'draft_saved', state: 'draft', values },
      input.note ?? null,
      userId,
    );
    const diff = changedFields(
      (analysis.proposal?.values ?? rowValues(pkg)) as unknown as Record<string, unknown>,
      values as unknown as Record<string, unknown>,
    );
    await recordAudit(tx, ctx.identity, {
      action: 'price_anchor.draft_saved',
      entityType: 'service_package',
      entityId: pkg.id,
      before: diff.before,
      after: { ...diff.after, revision: analysis.latestRevision + 1 },
      reason: input.note ?? null,
      correlationId: ctx.correlationId,
    });
    return reload(tx, pkg.id);
  });
}

function denySeparation(reason: string): never {
  throw new AuthorizationError({ allowed: false, code: 'separation_of_duties', reason });
}

/**
 * Moves the open proposal through review: submit (draft → in_review),
 * publish (in_review → live, by a different pricing manager with MFA),
 * reject (by someone other than the authors) or withdraw.
 */
export async function transitionPriceAnchor(
  ctx: AdminContext,
  id: string,
  input: PriceAnchorTransition,
): Promise<PriceAnchorDto> {
  authorize(ctx, 'pricing.manage');
  const userId = actorId(ctx);
  if (input.action === 'publish') requireVerifiedMfa(ctx, 'publishing a price anchor');
  const result = await transact(ctx, async (tx) => {
    const { pkg, analysis } = await loadPackageForUpdate(tx, id);
    assertRevision(analysis.latestRevision, input.expectedRevision);
    const proposal = analysis.proposal;
    const next = analysis.latestRevision + 1;
    const auditBase = {
      entityType: 'service_package',
      entityId: pkg.id,
      reason: input.reason,
      correlationId: ctx.correlationId,
    };

    switch (input.action) {
      case 'submit': {
        if (!proposal) throw new ApiError('invalid_transition', 'save a draft before submitting');
        if (proposal.state !== 'draft')
          throw new ApiError('invalid_transition', 'this proposal is already under review');
        await appendRevision(
          tx,
          pkg.id,
          next,
          { kind: 'price_anchor', event: 'submitted', state: 'in_review', values: proposal.values },
          input.reason,
          userId,
        );
        await recordAudit(tx, ctx.identity, {
          ...auditBase,
          action: 'price_anchor.submitted',
          after: { revision: next, values: proposal.values },
        });
        break;
      }
      case 'publish': {
        if (!proposal || proposal.state !== 'in_review')
          throw new ApiError(
            'invalid_transition',
            'only a proposal under review can be published; submit it first',
          );
        if (proposal.authorIds.includes(userId))
          denySeparation(
            'a price anchor must be published by a pricing manager who did not draft or submit it',
          );
        // Re-validate the stored proposal against the current rules before it goes live.
        const parsed = priceAnchorValuesSchema.safeParse({
          ...proposal.values,
          minimumScope: proposal.values.minimumScope ?? '',
          exclusions: proposal.values.exclusions ?? '',
          effectiveFrom: proposal.values.effectiveFrom ?? '',
        });
        if (!parsed.success)
          throw new ApiError(
            'validation_failed',
            'the proposal is incomplete; save a corrected draft first',
            {
              details: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
          );
        const values = valuesFromInput(parsed.data);
        const now = new Date();
        const [updated] = await tx
          .update(schema.servicePackages)
          .set({
            ...columnsFromValues(values),
            publicationState: 'published',
            reviewedBy: userId,
            reviewedAt: now,
            publishedAt: now,
            updatedBy: userId,
            version: pkg.version + 1,
          })
          .where(
            and(
              eq(schema.servicePackages.id, pkg.id),
              eq(schema.servicePackages.version, pkg.version),
            ),
          )
          .returning();
        if (!updated) throw versionConflict(pkg.version);
        await appendRevision(
          tx,
          pkg.id,
          next,
          { kind: 'price_anchor', event: 'published', state: 'published', values },
          input.reason,
          userId,
        );
        const diff = changedFields(
          { ...rowValues(pkg), publicationState: pkg.publicationState } as Record<string, unknown>,
          { ...values, publicationState: 'published' } as Record<string, unknown>,
        );
        await recordAudit(tx, ctx.identity, {
          ...auditBase,
          action: 'price_anchor.published',
          before: diff.before,
          after: { ...diff.after, revision: next, authors: proposal.authorIds },
        });
        break;
      }
      case 'reject': {
        if (!proposal || proposal.state !== 'in_review')
          throw new ApiError('invalid_transition', 'only a proposal under review can be rejected');
        if (proposal.authorIds.includes(userId))
          denySeparation('authors withdraw their own proposal; rejection needs another reviewer');
        await appendRevision(
          tx,
          pkg.id,
          next,
          { kind: 'price_anchor', event: 'rejected', state: 'rejected', values: proposal.values },
          input.reason,
          userId,
        );
        if (proposal.implicit) {
          // A seeded anchor that fails its first review stops being shown as "under review".
          await tx
            .update(schema.servicePackages)
            .set({ publicationState: 'draft', updatedBy: userId, version: pkg.version + 1 })
            .where(eq(schema.servicePackages.id, pkg.id));
        }
        await recordAudit(tx, ctx.identity, {
          ...auditBase,
          action: 'price_anchor.rejected',
          after: { revision: next, implicit: proposal.implicit },
        });
        break;
      }
      case 'withdraw': {
        if (!proposal || proposal.implicit)
          throw new ApiError(
            'invalid_transition',
            proposal?.implicit
              ? 'a seeded anchor under review is rejected, not withdrawn'
              : 'there is no open proposal to withdraw',
          );
        await appendRevision(
          tx,
          pkg.id,
          next,
          { kind: 'price_anchor', event: 'withdrawn', state: 'withdrawn', values: proposal.values },
          input.reason,
          userId,
        );
        await recordAudit(tx, ctx.identity, {
          ...auditBase,
          action: 'price_anchor.withdrawn',
          after: { revision: next },
        });
        break;
      }
    }
    return reload(tx, pkg.id);
  });
  // Cleared after commit so a concurrent public read cannot re-cache the old anchor.
  await clearPublicCaches();
  return result;
}

/** Removes a package from public display; history stays and a new proposal can re-publish it. */
export async function retirePriceAnchor(
  ctx: AdminContext,
  id: string,
  input: PriceAnchorRetire,
): Promise<PriceAnchorDto> {
  authorize(ctx, 'pricing.manage');
  requireVerifiedMfa(ctx, 'retiring a price anchor');
  const userId = actorId(ctx);
  const result = await transact(ctx, async (tx) => {
    const { pkg, analysis } = await loadPackageForUpdate(tx, id);
    assertVersion(pkg.version, input.expectedVersion);
    if (pkg.publicationState === 'retired')
      throw new ApiError('invalid_transition', 'this anchor is already retired');
    if (analysis.proposal && !analysis.proposal.implicit)
      throw new ApiError(
        'invalid_transition',
        'withdraw or decide the open proposal before retiring',
      );
    const [updated] = await tx
      .update(schema.servicePackages)
      .set({ publicationState: 'retired', updatedBy: userId, version: pkg.version + 1 })
      .where(
        and(
          eq(schema.servicePackages.id, pkg.id),
          eq(schema.servicePackages.version, pkg.version),
        ),
      )
      .returning();
    if (!updated) throw versionConflict(pkg.version);
    const next = analysis.latestRevision + 1;
    await appendRevision(
      tx,
      pkg.id,
      next,
      { kind: 'price_anchor', event: 'retired', state: 'retired', values: rowValues(pkg) },
      input.reason,
      userId,
    );
    await recordAudit(tx, ctx.identity, {
      action: 'price_anchor.retired',
      entityType: 'service_package',
      entityId: pkg.id,
      before: { publicationState: pkg.publicationState },
      after: { publicationState: 'retired', revision: next },
      reason: input.reason,
      correlationId: ctx.correlationId,
    });
    return reload(tx, pkg.id);
  });
  await clearPublicCaches();
  return result;
}

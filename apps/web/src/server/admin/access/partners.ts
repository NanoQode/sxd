import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import { actorId, authorize, iso, notFound, transact, type AdminContext } from '../context';

type PartnerRow = typeof schema.partnerProfiles.$inferSelect;

export interface PartnerQueueItem {
  id: string;
  userId: string;
  userName: string;
  email: string;
  partnerType: PartnerRow['partnerType'];
  displayName: string;
  credentials: PartnerRow['credentials'];
  availabilityStatus: string;
  conflictDisclosures: string | null;
  verificationStatus: PartnerRow['verificationStatus'];
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationExpiresAt: string | null;
  verificationScope: string | null;
  createdAt: string;
}

export async function listPartnerQueue(ctx: AdminContext): Promise<PartnerQueueItem[]> {
  authorize(ctx, 'access.partners.verify');
  return transact(ctx, async (tx) => {
    const rows = await tx
      .select({ p: schema.partnerProfiles, userName: schema.user.name, email: schema.user.email })
      .from(schema.partnerProfiles)
      .innerJoin(schema.user, eq(schema.user.id, schema.partnerProfiles.userId))
      .orderBy(
        asc(schema.partnerProfiles.verificationStatus),
        asc(schema.partnerProfiles.createdAt),
      );
    return rows.map(({ p, userName, email }) => ({
      id: p.id,
      userId: p.userId,
      userName,
      email,
      partnerType: p.partnerType,
      displayName: p.displayName,
      credentials: p.credentials,
      availabilityStatus: p.availabilityStatus,
      conflictDisclosures: p.conflictDisclosures,
      verificationStatus: p.verificationStatus,
      verifiedAt: iso(p.verifiedAt),
      verifiedBy: p.verifiedBy,
      verificationExpiresAt: iso(p.verificationExpiresAt),
      verificationScope: p.verificationScope,
      createdAt: p.createdAt.toISOString(),
    }));
  });
}

/** Verification records what was checked; the badge later states exactly that scope. */
export async function verifyPartner(
  ctx: AdminContext,
  id: string,
  input: { decision: 'verify' | 'reject'; scopeNote: string; expiresAt?: string | null },
): Promise<PartnerQueueItem> {
  authorize(ctx, 'access.partners.verify');
  const userId = actorId(ctx);
  await transact(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.partnerProfiles)
      .where(eq(schema.partnerProfiles.id, id));
    const current = rows[0];
    if (!current) throw notFound('partner profile');
    const now = new Date();
    await tx
      .update(schema.partnerProfiles)
      .set(
        input.decision === 'verify'
          ? {
              verificationStatus: 'verified',
              verifiedAt: now,
              verifiedBy: userId,
              verificationExpiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
              verificationScope: input.scopeNote,
            }
          : {
              verificationStatus: 'rejected',
              verifiedAt: null,
              verifiedBy: userId,
              verificationExpiresAt: null,
              verificationScope: input.scopeNote,
            },
      )
      .where(eq(schema.partnerProfiles.id, id));
    await recordAudit(tx, ctx.identity, {
      action: input.decision === 'verify' ? 'partner.verified' : 'partner.rejected',
      entityType: 'partner_profile',
      entityId: id,
      before: {
        verificationStatus: current.verificationStatus,
        verificationScope: current.verificationScope,
      },
      after: {
        verificationStatus: input.decision === 'verify' ? 'verified' : 'rejected',
        verificationScope: input.scopeNote,
        expiresAt: input.expiresAt ?? null,
      },
      reason: input.scopeNote,
      correlationId: ctx.correlationId,
    });
  });
  const items = await listPartnerQueue(ctx);
  const item = items.find((p) => p.id === id);
  if (!item) throw notFound('partner profile');
  return item;
}

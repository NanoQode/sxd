import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { appendOutbox, getDb, schema, withActor } from '@simplexd/db';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';

export const RETENTION_POLICY_SUMMARY =
  'Deletion requests are handled by support within 30 days. Accounting, contractual and legal records (invoices, receipts, signed acceptances, evidence linked to engagements) are retained for the statutory period even after your profile is removed; everything else is deleted or anonymised. You will receive a written outcome.';

/**
 * Creates a support lead and an audit entry rather than deleting anything
 * immediately: some records must be retained for accounting and legal reasons,
 * and support communicates the outcome. Repeat requests are deduplicated.
 */
export async function requestAccountDeletion(
  identity: RequestIdentity,
  input: { confirmEmail: string; reason?: string },
  options: { correlationId: string; ipHash: string | null },
): Promise<{ leadId: string; alreadyRequested: boolean; retentionPolicy: string }> {
  if (!identity.session) throw new ApiError('unauthenticated', 'sign in required');
  const user = identity.session.user;
  if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError('validation_failed', 'type your account email exactly to confirm', {
      details: [{ path: 'confirmEmail', message: 'does not match your account email' }],
    });
  }
  return withActor(
    getDb(),
    { ...identity.ctx, correlationId: options.correlationId },
    async (tx) => {
      const existing = await tx
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(
          and(
            eq(schema.leads.userId, user.id),
            sql`${schema.leads.context} ->> 'kind' = 'account_deletion'`,
            sql`${schema.leads.status} IN ('new','contacted','qualified')`,
          ),
        );
      if (existing[0]) {
        return {
          leadId: existing[0].id,
          alreadyRequested: true,
          retentionPolicy: RETENTION_POLICY_SUMMARY,
        };
      }
      const [lead] = await tx
        .insert(schema.leads)
        .values({
          userId: user.id,
          organizationId: identity.ctx.organizationId,
          contactName: user.name,
          email: user.email.toLowerCase(),
          source: 'manual',
          goal: 'other',
          message: `Account deletion request.${input.reason ? ` Reason: ${input.reason}` : ''}`,
          context: { kind: 'account_deletion', requestedAt: new Date().toISOString() },
          status: 'new',
          ipHash: options.ipHash,
        })
        .returning({ id: schema.leads.id });
      await appendOutbox(tx, {
        eventType: 'account.deletion_requested',
        aggregateType: 'user',
        aggregateId: user.id,
        organizationId: identity.ctx.organizationId,
        actorUserId: user.id,
        payload: { leadId: lead!.id, email: user.email },
        correlationId: options.correlationId,
      });
      await recordAudit(tx, identity, {
        action: 'account.deletion_requested',
        entityType: 'user',
        entityId: user.id,
        after: { leadId: lead!.id },
        reason: input.reason ?? null,
        correlationId: options.correlationId,
      });
      return {
        leadId: lead!.id,
        alreadyRequested: false,
        retentionPolicy: RETENTION_POLICY_SUMMARY,
      };
    },
  );
}

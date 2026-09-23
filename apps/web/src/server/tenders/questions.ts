import 'server-only';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { ApiError, type TenderQuestionDto } from '@simplexd/contracts';
import { appendOutbox, enqueueJob, getDb, schema, withActor, type DbExecutor } from '@simplexd/db';
import { questionWindowDecision } from '@simplexd/domain/tenders';
import { recordAudit } from '@/lib/audit';
import type { RequestIdentity } from '@/lib/auth/session';
import { ctxFor, dbNow, iso, loadTenderAccess, requireTendering, type ServiceOptions, type TenderAccess } from './shared';

/**
 * Clarification questions. Invited partners ask before the question cutoff;
 * staff answer. A published answer is visible to every invitee anonymised
 * (the asker is never revealed); unpublished answers are visible only to
 * staff and the asker. Row-level security enforces the same rule.
 */

type QuestionRow = typeof schema.tenderQuestions.$inferSelect;

function toDto(row: QuestionRow, viewerId: string, revealAsker: boolean): TenderQuestionDto {
  return {
    id: row.id,
    tenderId: row.tenderId,
    question: row.question,
    askedAt: row.askedAt.toISOString(),
    askedByUserId: revealAsker ? row.askedByUserId : null,
    askedByMe: row.askedByUserId === viewerId,
    answer: row.answer,
    answeredAt: iso(row.answeredAt),
    published: row.published,
  };
}

export async function listQuestionsInTx(
  tx: DbExecutor,
  identity: RequestIdentity,
  access: TenderAccess,
): Promise<TenderQuestionDto[]> {
  const userId = identity.session!.user.id;
  const tenderId = access.tender.id;
  const where =
    access.role === 'staff'
      ? eq(schema.tenderQuestions.tenderId, tenderId)
      : access.role === 'partner'
        ? and(
            eq(schema.tenderQuestions.tenderId, tenderId),
            or(eq(schema.tenderQuestions.askedByUserId, userId), eq(schema.tenderQuestions.published, true)),
          )
        : and(eq(schema.tenderQuestions.tenderId, tenderId), eq(schema.tenderQuestions.published, true));
  const rows = await tx.select().from(schema.tenderQuestions).where(where).orderBy(asc(schema.tenderQuestions.askedAt));
  return rows.map((r) => toDto(r, userId, access.role === 'staff'));
}

export async function listTenderQuestions(
  identity: RequestIdentity,
  tenderId: string,
  options: ServiceOptions = {},
): Promise<TenderQuestionDto[]> {
  requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId);
    return listQuestionsInTx(tx, identity, access);
  });
}

export async function askTenderQuestion(
  identity: RequestIdentity,
  tenderId: string,
  input: { question: string },
  options: ServiceOptions = {},
): Promise<TenderQuestionDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { customer: false });
    if (access.role !== 'partner') throw new ApiError('forbidden', 'only invited partners ask questions');
    const { tender } = access;
    if (tender.status !== 'published' && tender.status !== 'clarifications') {
      throw new ApiError('invalid_transition', 'questions are only accepted while the tender is open', {
        details: { status: tender.status },
      });
    }
    const now = await dbNow(tx);
    const window = questionWindowDecision({
      now: now.iso,
      questionCutoffAt: iso(tender.questionCutoffAt),
      submissionDeadlineAt: iso(tender.submissionDeadlineAt) ?? '',
    });
    if (!window.allowed) {
      throw new ApiError('deadline_passed', 'the question window has closed', {
        details: { reason: window.reason, closesAt: window.closesAt, serverNow: now.iso },
      });
    }
    const [row] = await tx
      .insert(schema.tenderQuestions)
      .values({ tenderId, askedByUserId: userId, question: input.question })
      .returning();
    await appendOutbox(tx, {
      eventType: 'tender.question.asked',
      aggregateType: 'tender',
      aggregateId: tenderId,
      organizationId: tender.organizationId,
      actorUserId: userId,
      payload: { tenderId, questionId: row!.id },
      correlationId: options.correlationId,
    });
    await recordAudit(tx, identity, {
      action: 'tender.question.asked',
      entityType: 'tender_question',
      entityId: row!.id,
      organizationId: tender.organizationId,
      after: { tenderId },
      correlationId: options.correlationId,
    });
    return toDto(row!, userId, false);
  });
}

async function publishInTx(
  tx: DbExecutor,
  identity: RequestIdentity,
  access: TenderAccess,
  question: QuestionRow,
  options: ServiceOptions,
): Promise<void> {
  const userId = identity.session!.user.id;
  const invitees = await tx
    .select({ partnerUserId: schema.tenderInvitations.partnerUserId })
    .from(schema.tenderInvitations)
    .where(and(eq(schema.tenderInvitations.tenderId, access.tender.id), sql`${schema.tenderInvitations.status} <> 'declined'`));
  await appendOutbox(tx, {
    eventType: 'tender.question.answered',
    aggregateType: 'tender',
    aggregateId: access.tender.id,
    organizationId: access.tender.organizationId,
    actorUserId: userId,
    payload: { tenderId: access.tender.id, questionId: question.id, recipientUserIds: invitees.map((i) => i.partnerUserId) },
    correlationId: options.correlationId,
  });
  await enqueueJob(tx, {
    type: 'tenders.publish_answers',
    queue: 'notifications',
    payload: { tenderId: access.tender.id, questionId: question.id },
    organizationId: access.tender.organizationId,
    actorUserId: userId,
    dedupeKey: `tenders.publish_answers:${question.id}`,
    correlationId: options.correlationId,
  });
}

export async function answerTenderQuestion(
  identity: RequestIdentity,
  tenderId: string,
  questionId: string,
  input: { answer: string; publish: boolean },
  options: ServiceOptions = {},
): Promise<TenderQuestionDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { staff: ['tenders.manage'], customer: false });
    const [question] = await tx
      .select()
      .from(schema.tenderQuestions)
      .where(and(eq(schema.tenderQuestions.id, questionId), eq(schema.tenderQuestions.tenderId, tenderId)));
    if (!question) throw new ApiError('not_found', 'question not found');
    const now = await dbNow(tx);
    const [updated] = await tx
      .update(schema.tenderQuestions)
      .set({ answer: input.answer, answeredBy: userId, answeredAt: now.date, published: question.published || input.publish })
      .where(eq(schema.tenderQuestions.id, questionId))
      .returning();
    if (input.publish && !question.published) await publishInTx(tx, identity, access, updated!, options);
    await recordAudit(tx, identity, {
      action: input.publish ? 'tender.question.answered_and_published' : 'tender.question.answered',
      entityType: 'tender_question',
      entityId: questionId,
      organizationId: access.tender.organizationId,
      before: { answer: question.answer, published: question.published },
      after: { answered: true, published: updated!.published },
      correlationId: options.correlationId,
    });
    return toDto(updated!, userId, true);
  });
}

export async function publishTenderAnswer(
  identity: RequestIdentity,
  tenderId: string,
  questionId: string,
  options: ServiceOptions = {},
): Promise<TenderQuestionDto> {
  const userId = requireTendering(identity);
  return withActor(getDb(), ctxFor(identity, options), async (tx) => {
    const access = await loadTenderAccess(tx, identity, tenderId, { staff: ['tenders.manage'], customer: false });
    const [question] = await tx
      .select()
      .from(schema.tenderQuestions)
      .where(and(eq(schema.tenderQuestions.id, questionId), eq(schema.tenderQuestions.tenderId, tenderId)));
    if (!question) throw new ApiError('not_found', 'question not found');
    if (!question.answer) throw new ApiError('invalid_transition', 'answer the question before publishing it');
    if (question.published) return toDto(question, userId, true);
    const [updated] = await tx
      .update(schema.tenderQuestions)
      .set({ published: true })
      .where(eq(schema.tenderQuestions.id, questionId))
      .returning();
    await publishInTx(tx, identity, access, updated!, options);
    await recordAudit(tx, identity, {
      action: 'tender.question.published',
      entityType: 'tender_question',
      entityId: questionId,
      organizationId: access.tender.organizationId,
      before: { published: false },
      after: { published: true },
      correlationId: options.correlationId,
    });
    return toDto(updated!, userId, true);
  });
}

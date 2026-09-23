import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@simplexd/contracts';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import {
  dispatchOutboxEvent,
  dispatchRequest,
  ensureNotificationTemplates,
  getDevMailProvider,
  getDevSmsProvider,
  type PipelineOptions,
} from '@simplexd/notifications';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  changeTemplateStatus,
  createTemplateVersion,
  deliveryLog,
  liftSuppression,
  listTemplateCatalog,
  previewTemplateWithSamples,
  restoreTemplate,
  retryDelivery,
  sendTestMessage,
  simulateReceipt,
  suppressionList,
  templateFamily,
  updateTemplateDraft,
} from './service';

/**
 * Admin → Communications: versioned templates with sample-only previews,
 * labelled test sends returning the provider's real answer, idempotent retry
 * of failed attempts, SMS only to verified numbers, audited unsuppression and
 * permission denials. Uses the labelled development adapters injected
 * explicitly so an active provider configuration left by another suite
 * cannot interfere.
 */

const sfx = uniqueSuffix();
const users = {
  admin: { id: `comm_admin_${sfx}`, name: 'Comms Admin', email: `comm-admin-${sfx}@example.test` },
  support: {
    id: `comm_support_${sfx}`,
    name: 'Sola Support',
    email: `comm-support-${sfx}@example.test`,
  },
  customer: {
    id: `comm_cust_${sfx}`,
    name: 'Chukwuemeka RealCustomer',
    email: `comm-cust-${sfx}@example.test`,
  },
};

const mail = getDevMailProvider('test');
const sms = getDevSmsProvider('test');
const pipeline: PipelineOptions = { providers: { mail, sms } };

/** Unique Nigerian mobile number per run; the suffix avoids the dev adapter's special endings. */
function phone(tail: string): string {
  const mid = String(Math.floor(Math.random() * 9000) + 1000);
  return `+23480${mid}${tail}`;
}

let dbs: TestDatabases;
let admin: AdminContext;
let support: AdminContext;
let customer: AdminContext;

async function auditRows(action: string, entityId: string) {
  return dbs.owner
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.entityId, entityId)));
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

async function denied(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthorizationError);
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  await ensureNotificationTemplates(dbs.owner);
  await insertStaffUser(dbs.owner, users.admin, ['super_admin']);
  await insertStaffUser(dbs.owner, users.support, ['support']);
  await insertStaffUser(dbs.owner, users.customer, []);
  await dbs.owner.insert(schema.userProfiles).values({
    userId: users.customer.id,
    phoneE164: phone('5678'),
    phoneVerifiedAt: new Date(),
  });
  admin = contextFor(dbs.app, identityFor(users.admin, ['super_admin']));
  support = contextFor(dbs.app, identityFor(users.support, ['support']));
  customer = contextFor(dbs.app, identityFor(users.customer, []));
});

afterAll(async () => {
  await dbs.close();
});

describe('template versioning', () => {
  const key = `comm_tpl_${sfx}`;

  it('edits create new versions, activation retires the previous one and rollback copies without rewriting history', async () => {
    const v1 = await createTemplateVersion(admin, {
      key,
      channel: 'sms',
      locale: 'en',
      bodyText: 'Hello {{name}}, version one.',
    });
    expect(v1).toMatchObject({ version: 1, status: 'draft', variables: ['name'] });
    await changeTemplateStatus(admin, v1.id, 'approve');

    const v2 = await createTemplateVersion(admin, {
      key,
      channel: 'sms',
      locale: 'en',
      bodyText: 'Hello {{name}}, version two with {{reference}}.',
    });
    expect(v2.version).toBe(2);
    await changeTemplateStatus(admin, v2.id, 'approve');

    let family = await templateFamily(admin, { key, channel: 'sms' });
    expect(family.active?.version).toBe(2);
    expect(family.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'approved'],
      [1, 'retired'],
    ]);
    expect(family.variables.map((v) => v.name)).toEqual(['name', 'reference']);
    expect(family.sms).toMatchObject({ unitCostKobo: 400, source: 'default' });

    // Approved versions are immutable.
    const immutable = await apiError(
      updateTemplateDraft(admin, v2.id, { bodyText: 'sneaky edit' }),
    );
    expect(immutable.code).toBe('invalid_transition');

    // Rollback: a new version with v1's content becomes active; v1 and v2 are untouched.
    const rollback = await restoreTemplate(admin, v1.id, {
      activate: true,
      reason: 'v2 had a typo',
    });
    expect(rollback).toMatchObject({ restoredFrom: 1, previousActiveVersion: 2 });
    expect(rollback.template).toMatchObject({
      version: 3,
      status: 'approved',
      bodyText: 'Hello {{name}}, version one.',
    });
    family = await templateFamily(admin, { key, channel: 'sms' });
    expect(family.versions.map((v) => [v.version, v.status, v.bodyText.includes('two')])).toEqual([
      [3, 'approved', false],
      [2, 'retired', true],
      [1, 'retired', false],
    ]);
    const audits = await auditRows('template.rollback', rollback.template.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('v2 had a typo');
    expect(audits[0]!.after).toMatchObject({ restoredFrom: 1, version: 3 });

    const catalog = await listTemplateCatalog(admin, { search: key });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ activeVersion: 3, versionCount: 3, draftCount: 0 });
  });

  it('previews render on the server with sample values only, never with a customer record', async () => {
    const preview = await previewTemplateWithSamples(admin, {
      template: {
        channel: 'sms',
        bodyText: 'Hi {{name}}, invoice {{invoiceNumber}} for {{amount}} is due {{dueDate}}.',
      },
      sampleVariables: {},
    });
    expect(preview.text).toContain('Ada Sample');
    expect(preview.text).toContain('INV-SAMPLE-0001');
    expect(preview.text).not.toContain('RealCustomer');
    expect(preview.missing).toEqual([]);
    expect(preview.samples.map((s) => s.source)).toEqual([
      'catalogue',
      'catalogue',
      'catalogue',
      'derived',
    ]);
    // The naira sign forces Unicode; cost uses the default per-segment price.
    expect(preview.sms).toMatchObject({
      encoding: 'ucs2',
      segments: 2,
      unitCostKobo: 400,
      unitCostSource: 'default',
      estimatedCostKobo: 800,
    });
    expect(preview.sms?.unicodeCharacters).toContain('₦');

    const overridden = await previewTemplateWithSamples(admin, {
      template: { channel: 'sms', bodyText: 'Plain text for {{name}}: {{count}} items.' },
      sampleVariables: { name: 'Override Person' },
    });
    expect(overridden.text).toBe('Plain text for Override Person: 3 items.');
    expect(overridden.sms).toMatchObject({ encoding: 'gsm7', segments: 1, estimatedCostKobo: 400 });
    expect(overridden.samples.find((s) => s.name === 'name')?.source).toBe('override');

    const email = await previewTemplateWithSamples(admin, {
      template: {
        channel: 'email',
        subject: 'Report {{reportTitle}}',
        bodyText: 'See {{reportUrl}}',
      },
      sampleVariables: {},
    });
    expect(email.subject).toBe('Report Sample due diligence report');
    expect(email.html).toContain('<!DOCTYPE html>');
    expect(email.text).toMatch(/\/sample\/report$/);
  });
});

describe('test sends and the delivery log', () => {
  let rejectedId: string;
  let acceptedId: string;
  const goodNumber = phone('4321');

  it('records a labelled attempt with the real provider answer and flags the development adapter', async () => {
    const accepted = await sendTestMessage(
      admin,
      { channel: 'sms', to: goodNumber.replace('+234', '0') },
      pipeline,
    );
    expect(accepted.to).toBe(goodNumber);
    expect(accepted.outcome.status).toBe('accepted');
    expect(accepted.provider).toMatchObject({ adapter: 'dev', developmentAdapter: true });
    expect(accepted.attempt).toMatchObject({
      isTest: true,
      developmentAdapter: true,
      status: 'accepted',
      delivery: 'awaiting_receipt',
      recipientMasked: `+234 ••• ••• 4321`,
    });
    expect(accepted.attempt!.recipientMasked).not.toContain(goodNumber.slice(4, 10));
    acceptedId = accepted.attempt!.id;
    expect(await auditRows('notifications.test_send', acceptedId)).toHaveLength(1);

    const rejected = await sendTestMessage(admin, { channel: 'sms', to: phone('0000') }, pipeline);
    expect(rejected.outcome.status).toBe('failed');
    expect(rejected.outcome.reason).toContain('simulated provider rejection');
    expect(rejected.attempt).toMatchObject({ status: 'failed', delivery: 'failed' });
    expect(rejected.attempt!.retry).toEqual({ allowed: true, reason: null });
    rejectedId = rejected.attempt!.id;

    const email = await sendTestMessage(
      admin,
      { channel: 'email', to: `comm-inbox-${sfx}@example.test`, templateKey: 'invoice_due' },
      pipeline,
    );
    expect(email.outcome.status).toBe('sent');
    expect(email.attempt?.delivery).toBe('not_reported');
    expect(email.samples.map((s) => s.name)).toContain('invoiceNumber');
    const delivered = mail.outbox.find((m) => m.to[0]?.email === `comm-inbox-${sfx}@example.test`);
    expect(delivered?.text).toContain('INV-SAMPLE-0001');
    expect(delivered?.text).not.toContain('RealCustomer');

    const unknown = await apiError(
      sendTestMessage(admin, { channel: 'sms', to: goodNumber, templateKey: 'no_such_tpl' }),
    );
    expect(unknown.code).toBe('validation_failed');
  });

  it('a simulated development receipt moves accepted to delivered through the real webhook handler', async () => {
    const result = await simulateReceipt(admin, acceptedId, 'delivered', pipeline);
    expect(result.action).toBe('attempt:delivered');
    expect(result.attempt).toMatchObject({ status: 'delivered', delivery: 'confirmed' });
    expect(result.attempt.timeline.map((s) => s.state)).toEqual([
      'queued',
      'accepted',
      'delivered',
    ]);
    const again = await apiError(simulateReceipt(admin, acceptedId, 'delivered', pipeline));
    expect(again.code).toBe('invalid_transition');
  });

  it('retry of a failed attempt is idempotent and audited once', async () => {
    const before = sms.outbox.length;
    const first = await retryDelivery(admin, rejectedId, pipeline);
    expect(first.created).toBe(true);
    expect(first.retry.retryOf).toBe(rejectedId);
    expect(first.original.retriedBy).toBe(first.retry.id);
    // The number still ends in 0000, so the provider rejects the retry as well.
    expect(first.retry.status).toBe('failed');
    expect(first.original.retry).toEqual({ allowed: false, reason: 'already_retried' });

    const second = await retryDelivery(admin, rejectedId, pipeline);
    expect(second.created).toBe(false);
    expect(second.retry.id).toBe(first.retry.id);
    expect(sms.outbox.length).toBe(before);
    expect(await auditRows('notifications.delivery.retried', rejectedId)).toHaveLength(1);

    const notFailed = await apiError(retryDelivery(admin, acceptedId, pipeline));
    expect(notFailed.code).toBe('invalid_transition');
  });

  it('retries an outbox-sourced failure by re-rendering the event once the recipient is fixed', async () => {
    const userId = `comm_retry_${sfx}`;
    await dbs.owner
      .insert(schema.user)
      .values({ id: userId, name: 'Retry Person', email: `${userId}@example.test` });
    await dbs.owner.insert(schema.userProfiles).values({
      userId,
      phoneE164: phone('0000'),
      phoneVerifiedAt: new Date(),
    });
    const [event] = await dbs.owner
      .insert(schema.outboxEvents)
      .values({
        eventType: 'notification.requested',
        aggregateType: 'test',
        aggregateId: userId,
        payload: {
          templateKey: 'invoice_due',
          channels: ['sms'],
          userId,
          variables: {
            name: 'Retry Person',
            invoiceNumber: 'INV-9',
            amount: '₦1.00',
            dueDate: 'today',
            invoiceUrl: 'http://localhost:3000/x',
          },
        },
      })
      .returning();
    const dispatched = await dispatchOutboxEvent(
      dbs.app,
      {
        id: event!.id,
        type: event!.eventType,
        aggregateType: event!.aggregateType,
        aggregateId: event!.aggregateId,
        payload: event!.payload,
      },
      pipeline,
    );
    const failed = dispatched.outcomes[0]!;
    expect(failed.status).toBe('failed');

    const log = await deliveryLog(admin, {
      recipient: userId,
      limit: 10,
      testOnly: false,
      developmentOnly: false,
    });
    expect(log.items[0]).toMatchObject({ id: failed.attemptId, retry: { allowed: true } });

    // The person corrects their number (and verifies it); the retry re-resolves them.
    await dbs.owner
      .update(schema.userProfiles)
      .set({ phoneE164: phone('7777'), phoneVerifiedAt: new Date() })
      .where(eq(schema.userProfiles.userId, userId));
    const retried = await retryDelivery(admin, failed.attemptId!, pipeline);
    expect(retried.created).toBe(true);
    expect(retried.retry).toMatchObject({
      status: 'accepted',
      templateKey: 'invoice_due',
      templateVersion: 1,
      userId,
    });
    expect(sms.outbox.at(-1)?.body).toContain('INV-9');
  });

  it('skips SMS to unverified numbers with a recorded reason', async () => {
    const userId = `comm_unverified_${sfx}`;
    const number = phone('3333');
    await dbs.owner
      .insert(schema.user)
      .values({ id: userId, name: 'Unverified Person', email: `${userId}@example.test` });
    await dbs.owner.insert(schema.userProfiles).values({ userId, phoneE164: number });
    const variables = {
      name: 'U',
      invoiceNumber: 'INV-U',
      amount: '₦1.00',
      dueDate: 'today',
      invoiceUrl: 'http://localhost:3000/x',
    };
    const skipped = await dispatchRequest(
      dbs.app,
      {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ['sms'],
        recipients: [{ userId }],
        variables,
        dedupeScope: `unverified:${sfx}`,
      },
      pipeline,
    );
    expect(skipped.outcomes[0]).toMatchObject({ status: 'suppressed', reason: 'phone_unverified' });
    expect(sms.outbox.some((m) => m.to === number)).toBe(false);
    const [row] = await dbs.owner
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, skipped.outcomes[0]!.attemptId!));
    expect(row).toMatchObject({ status: 'suppressed', errorSanitized: 'phone_unverified' });
    const item = (
      await deliveryLog(admin, {
        recipient: number,
        limit: 5,
        testOnly: false,
        developmentOnly: false,
      })
    ).items[0]!;
    expect(item.timeline.at(-1)).toMatchObject({ state: 'suppressed' });
    expect(item.retry).toEqual({ allowed: false, reason: 'not_failed' });

    await dbs.owner
      .update(schema.userProfiles)
      .set({ phoneVerifiedAt: new Date() })
      .where(eq(schema.userProfiles.userId, userId));
    const sent = await dispatchRequest(
      dbs.app,
      {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ['sms'],
        recipients: [{ userId }],
        variables,
        dedupeScope: `verified:${sfx}`,
      },
      pipeline,
    );
    expect(sent.outcomes[0]?.status).toBe('accepted');
  });

  it('masks recipients in the log and only matches exact addresses', async () => {
    const page = await deliveryLog(admin, {
      recipient: goodNumber,
      testOnly: true,
      developmentOnly: false,
      limit: 5,
    });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.recipientMasked).toBe('+234 ••• ••• 4321');
      expect(item.developmentAdapter).toBe(true);
      expect(item.timeline[0]?.state).toBe('queued');
    }
    const partial = await deliveryLog(admin, {
      recipient: goodNumber.slice(0, 8),
      testOnly: false,
      developmentOnly: false,
      limit: 5,
    });
    expect(partial.items).toHaveLength(0);
  });
});

describe('suppressions', () => {
  it('lifting a STOP suppression needs a reason, is audited and leaves the opt-out consent in place', async () => {
    const number = phone('8888');
    await dbs.owner.insert(schema.suppressions).values({
      channel: 'sms',
      address: number,
      reason: 'stop_keyword',
      source: 'termii_inbound_stop',
    });
    await dbs.owner.insert(schema.smsConsents).values({
      phoneE164: number,
      category: 'transactional',
      status: 'opted_out',
      source: 'termii_inbound_stop',
    });
    const list = await suppressionList(admin, { address: number, limit: 5 });
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item).toMatchObject({ kind: 'stop_reply', channel: 'sms' });
    expect(item.addressMasked).not.toContain(number.slice(4, 10));

    const tooShort = await apiError(liftSuppression(admin, item.id, 'ok'));
    expect(tooShort.code).toBe('validation_failed');

    const lifted = await liftSuppression(admin, item.id, 'Customer asked by phone to resume');
    expect(lifted.consentStillOptedOut).toBe(true);
    const audits = await auditRows('notifications.suppression.removed', item.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('Customer asked by phone to resume');
    expect(JSON.stringify(audits[0]!.before)).not.toContain(number.slice(4, 10));
    expect((await suppressionList(admin, { address: number, limit: 5 })).items).toHaveLength(0);

    const gone = await apiError(liftSuppression(admin, item.id, 'already removed'));
    expect(gone.code).toBe('not_found');
  });
});

describe('permissions', () => {
  it('staff without notifications.templates.manage cannot read or edit templates or the log', async () => {
    await denied(listTemplateCatalog(support));
    await denied(
      createTemplateVersion(support, {
        key: 'x_denied',
        channel: 'sms',
        locale: 'en',
        bodyText: 'x',
      }),
    );
    await denied(deliveryLog(support, { limit: 5, testOnly: false, developmentOnly: false }));
    await denied(suppressionList(support, { limit: 5 }));
    await denied(sendTestMessage(support, { channel: 'sms', to: '+2348035550001' }, pipeline));
  });

  it('customers cannot reach any communications endpoint', async () => {
    await denied(listTemplateCatalog(customer));
    await denied(
      previewTemplateWithSamples(customer, {
        template: { channel: 'sms', bodyText: 'x' },
        sampleVariables: {},
      }),
    );
    await denied(deliveryLog(customer, { limit: 5, testOnly: false, developmentOnly: false }));
    await denied(sendTestMessage(customer, { channel: 'sms', to: '+2348035550001' }, pipeline));
    await denied(retryDelivery(customer, '00000000-0000-4000-8000-000000000000', pipeline));
  });
});

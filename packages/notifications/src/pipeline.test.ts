import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import {
  connectTestDatabases,
  resetDatabase,
  uniqueSuffix,
  type TestDatabases,
} from '@simplexd/db/testing';
import { DEFERRED_QUEUE } from './send';
import {
  applyTemplateAction,
  createTemplate,
  dispatchOutboxEvent,
  dispatchRequest,
  ensureNotificationTemplates,
  getDevMailProvider,
  getDevSmsProvider,
  listDeliveries,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  previewNotificationTemplate,
  processBounce,
  processTermiiWebhook,
  providerStatus,
  sendDueReminders,
  sendDigests,
  testSend,
  unreadCount,
} from './index';

const dbs: TestDatabases = connectTestDatabases();
const mail = getDevMailProvider('test');
const sms = getDevSmsProvider('test');

interface Person {
  userId: string;
  email: string;
  phone: string;
}

let phoneCounter = 100;
async function createPerson(
  overrides: { timeZone?: string; marketingConsentAt?: Date | null } = {},
): Promise<Person> {
  const userId = `user_${uniqueSuffix()}`;
  const email = `${userId}@example.test`;
  phoneCounter += 1;
  const phone = `+23480${String(12340000 + phoneCounter).padStart(8, '0')}`;
  await dbs.owner
    .insert(schema.user)
    .values({ id: userId, name: `Person ${phoneCounter}`, email, emailVerified: true });
  await dbs.owner.insert(schema.userProfiles).values({
    userId,
    phoneE164: phone,
    timeZone: overrides.timeZone ?? 'Africa/Lagos',
    marketingConsentAt: overrides.marketingConsentAt ?? null,
  });
  return { userId, email, phone };
}

async function attemptsFor(scopePrefix: string) {
  const rows = await dbs.owner.select().from(schema.deliveryAttempts);
  return rows
    .filter((r) => r.dedupeKey?.startsWith(scopePrefix))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

const invoiceVariables = {
  invoiceNumber: 'INV-0001',
  amount: '₦150,000.00',
  dueDate: '2026-10-01',
  invoiceUrl: 'http://localhost:3000/portal/invoices/1',
};

describe('notification pipeline', () => {
  beforeAll(async () => {
    await resetDatabase(dbs.owner);
    await ensureNotificationTemplates(dbs.app);
  });

  afterAll(async () => {
    await dbs.close();
    await closeDb();
  });

  beforeEach(() => {
    mail.clear();
    sms.clear();
  });

  it('renders and records attempts for email, SMS and in-app', async () => {
    const person = await createPerson();
    const scope = `evt:${uniqueSuffix()}`;
    const result = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email', 'sms', 'in_app'],
      recipients: [{ userId: person.userId }],
      variables: (r) => ({ name: r.name, ...invoiceVariables }),
      dedupeScope: scope,
      inApp: { linkPath: '/portal/invoices/1' },
      relatedEntity: { type: 'invoice', id: null },
    });
    expect(result.retryable).toBe(false);
    const byChannel = Object.fromEntries(result.outcomes.map((o) => [o.channel, o]));
    expect(byChannel['email']?.status).toBe('sent');
    expect(byChannel['sms']?.status).toBe('accepted');
    expect(byChannel['in_app']?.status).toBe('delivered');

    const attempts = await attemptsFor(scope);
    expect(attempts.map((a) => [a.channel, a.status, a.provider])).toEqual([
      ['email', 'sent', 'dev'],
      ['in_app', 'delivered', 'in_app'],
      ['sms', 'accepted', 'dev'],
    ]);
    const smsAttempt = attempts.find((a) => a.channel === 'sms')!;
    expect(smsAttempt.segments).toBeGreaterThan(0);
    expect(smsAttempt.providerMessageId).toMatch(/^dev-sms-/);
    expect(smsAttempt.templateVersion).toBe(1);
    expect(attempts.find((a) => a.channel === 'email')!.subject).toContain('INV-0001');

    const sent = mail.outbox.find((m) => m.to[0]?.email === person.email);
    expect(sent).toBeDefined();
    expect(sent!.text).toContain('INV-0001');
    expect(sent!.html).toContain('<!DOCTYPE html>');
    expect(sms.outbox[0]?.body).toContain('INV-0001');

    const feed = await listNotifications(dbs.app, {
      userId: person.userId,
      organizationId: null,
      staff: false,
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.linkPath).toBe('/portal/invoices/1');
    expect(feed.unreadCount).toBe(1);
  });

  it('a replayed outbox event sends once per channel', async () => {
    const person = await createPerson();
    const event = {
      id: 424242,
      type: 'notification.requested',
      aggregateType: 'report',
      aggregateId: '00000000-0000-4000-8000-000000000001',
      payload: {
        kind: 'report_ready',
        channels: ['email', 'sms', 'in_app'],
        userId: person.userId,
        variables: {
          name: 'Ada',
          reportTitle: 'Site visit #3',
          reportUrl: 'http://localhost:3000/portal/reports/1',
        },
        linkPath: '/portal/reports/1',
      },
    };
    const first = await dispatchOutboxEvent(dbs.app, event);
    expect(first.handled).toBe(true);
    expect(first.outcomes.map((o) => o.status).sort()).toEqual(['accepted', 'delivered', 'sent']);
    const second = await dispatchOutboxEvent(dbs.app, event);
    expect(second.outcomes.every((o) => o.status === 'deduplicated')).toBe(true);
    expect(await attemptsFor('outbox:424242:')).toHaveLength(3);
    expect(mail.outbox.filter((m) => m.to[0]?.email === person.email)).toHaveLength(1);
    expect(sms.outbox.filter((m) => m.to === person.phone)).toHaveLength(1);
    const rows = await dbs.owner
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, person.userId));
    expect(rows).toHaveLength(1);
  });

  it('ignores unknown event types without failing', async () => {
    const result = await dispatchOutboxEvent(dbs.app, {
      id: 1,
      type: 'something.unmapped',
      aggregateType: 'x',
      aggregateId: 'y',
      payload: {},
    });
    expect(result).toMatchObject({ handled: false, outcomes: [], retryable: false });
  });

  it('suppresses marketing SMS without opt-in and after an opt-out, with the reason recorded', async () => {
    const noConsent = await createPerson();
    const optedOut = await createPerson({ marketingConsentAt: new Date() });
    for (const p of [noConsent, optedOut]) {
      await dbs.owner
        .insert(schema.notificationPreferences)
        .values({ userId: p.userId, channel: 'sms', category: 'marketing', enabled: true });
    }
    await dbs.owner
      .insert(schema.smsConsents)
      .values({
        phoneE164: optedOut.phone,
        userId: optedOut.userId,
        category: 'marketing',
        status: 'opted_out',
        source: 'test',
      });
    await dbs.owner.insert(schema.templates).values({
      key: 'promo',
      channel: 'sms',
      bodyText: 'SimplexD offer: {{offer}}. Reply STOP to opt out.',
      variables: ['offer'],
      status: 'approved',
    });
    const scope = `promo:${uniqueSuffix()}`;
    const result = await dispatchRequest(dbs.app, {
      templateKey: 'promo',
      category: 'marketing',
      channels: ['sms'],
      recipients: [{ userId: noConsent.userId }, { userId: optedOut.userId }],
      variables: { offer: '10% off inspections' },
      dedupeScope: scope,
    });
    const reasons = Object.fromEntries(
      result.outcomes.map((o) => [o.recipient, [o.status, o.reason]]),
    );
    expect(reasons[noConsent.phone]).toEqual(['suppressed', 'marketing_consent_required']);
    expect(reasons[optedOut.phone]).toEqual(['suppressed', 'marketing_opted_out']);
    expect(sms.outbox).toHaveLength(0);
    const attempts = await attemptsFor(scope);
    expect(attempts.every((a) => a.status === 'suppressed')).toBe(true);
  });

  it('defers non-security messages during quiet hours but sends security immediately, then the reminder sweep delivers', async () => {
    const person = await createPerson({ timeZone: 'Africa/Lagos' });
    await dbs.owner.insert(schema.notificationPreferences).values({
      userId: person.userId,
      channel: 'email',
      category: 'transactional',
      enabled: true,
      quietHoursStart: '21:00',
      quietHoursEnd: '08:00',
      timeZone: 'Africa/Lagos',
    });
    // 23:30 Lagos (UTC+1) = 22:30Z
    const now = new Date('2026-09-23T22:30:00Z');
    const scope = `quiet:${uniqueSuffix()}`;
    const deferred = await dispatchRequest(
      dbs.app,
      {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ['email'],
        recipients: [{ userId: person.userId }],
        variables: (r) => ({ name: r.name, ...invoiceVariables }),
        dedupeScope: scope,
      },
      { now: () => now },
    );
    expect(deferred.outcomes[0]).toMatchObject({ status: 'queued', reason: 'quiet_hours' });
    expect(deferred.outcomes[0]!.deferredUntil?.toISOString()).toBe('2026-09-24T07:00:00.000Z');
    expect(mail.outbox).toHaveLength(0);
    const [row] = await attemptsFor(scope);
    expect(row!.status).toBe('queued');
    expect(row!.queuedAt.toISOString()).toBe('2026-09-24T07:00:00.000Z');
    const jobs = await dbs.owner
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.queue, DEFERRED_QUEUE), eq(schema.jobs.status, 'pending')));
    expect(jobs.some((j) => j.dedupeKey === `deferred:${row!.dedupeKey}`)).toBe(true);

    const security = await dispatchRequest(
      dbs.app,
      {
        templateKey: 'password_reset',
        category: 'security',
        channels: ['email'],
        recipients: [{ userId: person.userId }],
        variables: (r) => ({
          name: r.name,
          resetUrl: 'http://localhost:3000/reset/x',
          expiresIn: '30 minutes',
        }),
        dedupeScope: `sec:${uniqueSuffix()}`,
      },
      { now: () => now },
    );
    expect(security.outcomes[0]!.status).toBe('sent');
    expect(mail.outbox).toHaveLength(1);

    // Too early: nothing due.
    const early = await sendDueReminders(dbs.app, { now: () => new Date('2026-09-24T05:00:00Z') });
    expect(early.deferredSent).toBe(0);
    const sweep = await sendDueReminders(dbs.app, { now: () => new Date('2026-09-24T07:01:00Z') });
    expect(sweep.deferredSent).toBe(1);
    const [after] = await attemptsFor(scope);
    expect(after!.status).toBe('sent');
    expect(mail.outbox.filter((m) => m.to[0]?.email === person.email)).toHaveLength(2);
    // A replay of the deferred event does not send again.
    const replay = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email'],
      recipients: [{ userId: person.userId }],
      variables: (r) => ({ name: r.name, ...invoiceVariables }),
      dedupeScope: scope,
    });
    expect(replay.outcomes[0]!.status).toBe('deduplicated');
  });

  it('delivery receipts update the attempt and an inbound STOP suppresses future SMS', async () => {
    const person = await createPerson();
    const scope = `stop:${uniqueSuffix()}`;
    const sent = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['sms'],
      recipients: [{ userId: person.userId }],
      variables: invoiceVariables,
      dedupeScope: scope,
    });
    const providerMessageId = sent.outcomes[0]!.providerMessageId!;
    const receipt = sms.simulateDeliveryReceipt(providerMessageId)!;
    const receiptOutcome = await processTermiiWebhook(dbs.app, receipt.rawBody, receipt.headers);
    expect(receiptOutcome).toMatchObject({
      status: 200,
      signature: 'valid',
      eventType: 'outbound',
      action: 'attempt:delivered',
    });
    const [delivered] = await attemptsFor(scope);
    expect(delivered!.status).toBe('delivered');
    expect(delivered!.deliveredAt).not.toBeNull();

    const tampered = await processTermiiWebhook(dbs.app, receipt.rawBody + ' ', receipt.headers);
    expect(tampered).toMatchObject({ status: 401, signature: 'invalid' });

    const inbound = sms.simulateInbound(person.phone, 'STOP')!;
    const stop = await processTermiiWebhook(dbs.app, inbound.rawBody, inbound.headers);
    expect(stop).toMatchObject({ status: 200, eventType: 'inbound', action: 'opt_out' });
    const suppression = await dbs.owner
      .select()
      .from(schema.suppressions)
      .where(eq(schema.suppressions.address, person.phone));
    expect(suppression[0]?.reason).toBe('stop_keyword');
    const consents = await dbs.owner
      .select()
      .from(schema.smsConsents)
      .where(eq(schema.smsConsents.phoneE164, person.phone));
    expect(consents.some((c) => c.category === 'transactional' && c.status === 'opted_out')).toBe(
      true,
    );

    const scope2 = `stop2:${uniqueSuffix()}`;
    const blocked = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'security',
      channels: ['sms'],
      recipients: [{ userId: person.userId }],
      variables: invoiceVariables,
      dedupeScope: scope2,
    });
    expect(blocked.outcomes[0]).toMatchObject({
      status: 'suppressed',
      reason: 'suppressed:stop_keyword',
    });
    expect(sms.outbox.filter((m) => m.to === person.phone)).toHaveLength(1);

    const start = sms.simulateInbound(person.phone, 'START')!;
    await processTermiiWebhook(dbs.app, start.rawBody, start.headers);
    expect(
      await dbs.owner
        .select()
        .from(schema.suppressions)
        .where(eq(schema.suppressions.address, person.phone)),
    ).toHaveLength(0);
  });

  it('fails safely when a template variable is missing', async () => {
    const person = await createPerson();
    const scope = `missing:${uniqueSuffix()}`;
    const result = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email', 'sms'],
      recipients: [{ userId: person.userId }],
      variables: { name: 'Ada', invoiceNumber: 'INV-2' },
      dedupeScope: scope,
    });
    for (const outcome of result.outcomes) {
      expect(outcome.status).toBe('failed');
      expect(outcome.reason).toMatch(/^missing_variables: /);
      expect(outcome.reason).toContain('amount');
    }
    expect(mail.outbox).toHaveLength(0);
    expect(sms.outbox).toHaveLength(0);
    const attempts = await attemptsFor(scope);
    expect(attempts.every((a) => a.status === 'failed' && a.failedAt !== null)).toBe(true);
  });

  it('records provider_not_configured in production when no provider is active', async () => {
    const person = await createPerson();
    const scope = `prod:${uniqueSuffix()}`;
    const result = await dispatchRequest(
      dbs.app,
      {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ['email', 'sms'],
        recipients: [{ userId: person.userId }],
        variables: (r) => ({ name: r.name, ...invoiceVariables }),
        dedupeScope: scope,
      },
      { appEnv: 'production' },
    );
    expect(result.retryable).toBe(false);
    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject({ status: 'failed', reason: 'provider_not_configured' });
    }
    const attempts = await attemptsFor(scope);
    expect(attempts.map((a) => [a.provider, a.environment, a.errorSanitized])).toEqual([
      ['smtp', 'live', 'provider_not_configured'],
      ['termii', 'live', 'provider_not_configured'],
    ]);
    expect(mail.outbox).toHaveLength(0);
    const log = await listDeliveries(dbs.app, { status: 'failed', recipient: person.email });
    expect(log.items[0]?.errorSanitized).toBe('provider_not_configured');
  });

  it('test sends record a labelled attempt with the real provider result', async () => {
    const actor = await createPerson();
    const emailResult = await testSend(
      dbs.app,
      { channel: 'email', to: 'ops@example.test' },
      { userId: actor.userId },
    );
    expect(emailResult.outcome.status).toBe('sent');
    expect(emailResult.attempt).toMatchObject({
      isTest: true,
      relatedEntityType: 'test_send',
      status: 'sent',
      provider: 'dev',
    });
    expect(emailResult.provider).toMatchObject({ adapter: 'dev', configured: true });
    expect(mail.outbox[0]?.tags).toContain('test');

    const smsResult = await testSend(
      dbs.app,
      { channel: 'sms', to: '0803 555 0000' },
      { userId: actor.userId },
    );
    // Dev adapter rejects numbers ending in 0000: the real (negative) result is surfaced, not masked.
    expect(smsResult.outcome.status).toBe('failed');
    expect(smsResult.attempt?.errorSanitized).toContain('simulated provider rejection');
    const log = await listDeliveries(dbs.app, { testOnly: true });
    expect(log.items.length).toBeGreaterThanOrEqual(2);
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'notifications.test_send'));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('bounce intake suppresses the address and marks the attempt bounced', async () => {
    const person = await createPerson();
    const scope = `bounce:${uniqueSuffix()}`;
    await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email'],
      recipients: [{ userId: person.userId }],
      variables: (r) => ({ name: r.name, ...invoiceVariables }),
      dedupeScope: scope,
    });
    const bounce = await processBounce(dbs.app, {
      email: person.email,
      kind: 'hard',
      reason: '550 no such user',
    });
    expect(bounce.suppressed).toBe(true);
    expect((await attemptsFor(scope))[0]!.status).toBe('bounced');
    const again = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email'],
      recipients: [{ userId: person.userId }],
      variables: (r) => ({ name: r.name, ...invoiceVariables }),
      dedupeScope: `${scope}b`,
    });
    expect(again.outcomes[0]).toMatchObject({
      status: 'suppressed',
      reason: 'suppressed:hard_bounce',
    });
  });

  it('digest preferences bundle in-app items into one email', async () => {
    const person = await createPerson();
    await dbs.owner
      .insert(schema.notificationPreferences)
      .values({
        userId: person.userId,
        channel: 'email',
        category: 'transactional',
        enabled: true,
        digest: 'daily',
      });
    for (const n of [1, 2]) {
      const result = await dispatchRequest(dbs.app, {
        templateKey: 'invoice_due',
        category: 'transactional',
        channels: ['email', 'in_app'],
        recipients: [{ userId: person.userId }],
        variables: (r) => ({ name: r.name, ...invoiceVariables, invoiceNumber: `INV-${n}` }),
        dedupeScope: `digest:${uniqueSuffix()}`,
      });
      expect(result.outcomes.find((o) => o.channel === 'email')).toMatchObject({
        status: 'suppressed',
        reason: 'digest:daily',
      });
    }
    expect(mail.outbox).toHaveLength(0);
    const digest = await sendDigests(dbs.app);
    expect(digest.digestsSent).toBe(1);
    const email = mail.outbox.find((m) => m.to[0]?.email === person.email)!;
    expect(email.subject).toContain('2 updates');
    expect(email.text).toContain('INV-1');
    expect(email.text).toContain('INV-2');
    const second = await sendDigests(dbs.app);
    expect(second.digestsSent).toBe(0);
  });

  it('feed: cursor paging, mark read and unread count', async () => {
    const person = await createPerson();
    const ctx = { userId: person.userId, organizationId: null, staff: false };
    for (let i = 0; i < 3; i += 1) {
      await dispatchRequest(dbs.app, {
        templateKey: 'report_ready',
        category: 'transactional',
        channels: ['in_app'],
        recipients: [{ userId: person.userId }],
        variables: { reportTitle: `Report ${i}` },
        dedupeScope: `feed:${uniqueSuffix()}`,
      });
    }
    const page1 = await listNotifications(dbs.app, ctx, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listNotifications(dbs.app, ctx, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(await unreadCount(dbs.app, ctx)).toBe(3);
    const read = await markNotificationRead(dbs.app, ctx, page1.items[0]!.id);
    expect(read?.readAt).not.toBeNull();
    expect(await unreadCount(dbs.app, ctx)).toBe(2);
    // Another user cannot read or mark this user's rows.
    const other = await createPerson();
    expect(
      await markNotificationRead(
        dbs.app,
        { userId: other.userId, organizationId: null, staff: false },
        page1.items[1]!.id,
      ),
    ).toBeNull();
    expect(await markAllNotificationsRead(dbs.app, ctx)).toBe(2);
    expect(await unreadCount(dbs.app, ctx)).toBe(0);
  });

  it('admin: template versions, approval, preview and provider status', async () => {
    const staff = await createPerson();
    const draft = await createTemplate(
      dbs.app,
      {
        key: 'invoice_due',
        channel: 'email',
        subject: 'Invoice {{invoiceNumber}} due {{dueDate}}',
        bodyText: 'Hello {{name}}, {{amount}} is due on {{dueDate}}: {{invoiceUrl}}',
      },
      { userId: staff.userId },
    );
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(2);
    expect(draft.variables).toEqual(['invoiceNumber', 'dueDate', 'name', 'amount', 'invoiceUrl']);
    const preview = await previewNotificationTemplate(dbs.app, {
      templateId: draft.id,
      sampleVariables: { name: 'Ada' },
    });
    expect(preview.missing).toEqual(['invoiceNumber', 'dueDate', 'amount', 'invoiceUrl']);
    expect(preview.text).toContain('Ada');
    expect(preview.html).toContain('[invoiceNumber]');
    const approved = await applyTemplateAction(dbs.app, draft.id, 'approve', {
      userId: staff.userId,
    });
    expect(approved.status).toBe('approved');
    const v1 = await dbs.owner
      .select()
      .from(schema.templates)
      .where(
        and(
          eq(schema.templates.key, 'invoice_due'),
          eq(schema.templates.channel, 'email'),
          eq(schema.templates.version, 1),
        ),
      );
    expect(v1[0]!.status).toBe('retired');
    // Sends now use version 2.
    const person = await createPerson();
    const result = await dispatchRequest(dbs.app, {
      templateKey: 'invoice_due',
      category: 'transactional',
      channels: ['email'],
      recipients: [{ userId: person.userId }],
      variables: (r) => ({ name: r.name, ...invoiceVariables }),
      dedupeScope: `v2:${uniqueSuffix()}`,
    });
    expect(result.outcomes[0]!.status).toBe('sent');
    expect(mail.outbox[0]!.subject).toBe('Invoice INV-0001 due 2026-10-01');
    const status = await providerStatus(dbs.app);
    expect(status.map((s) => [s.provider, s.configured, s.devFallback])).toEqual([
      ['smtp', false, true],
      ['termii', false, true],
    ]);
    expect(JSON.stringify(status)).not.toMatch(/password|apiKey|secret/i);
  });
});

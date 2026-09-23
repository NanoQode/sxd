import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@simplexd/db';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { staffIdentity } from '@/testing/identity';
import { addLeadNote, convertLead, getLeadDetail, listLeads, updateLead } from './admin';

/**
 * CRM administration: assignment, status changes with notes and audit, and
 * both conversion paths (existing customer organisation → service request;
 * unknown email → invitation queued through the outbox).
 */

let dbs: TestDatabases;
const sfx = uniqueSuffix();
const opsId = `crm_ops_${sfx}`;
const pmId = `crm_pm_${sfx}`;
const customerId = `crm_customer_${sfx}`;
const orgId = `crm_org_${sfx}`;
const customerEmail = `${customerId}@example.test`;
let serviceId: string;
let serviceSlug: string;
let leadWithAccount: string;
let leadWithoutAccount: string;

const ops = () => staffIdentity({ userId: opsId, email: `${opsId}@example.test`, roles: ['operations_manager'] });
const supportOnly = () => staffIdentity({ userId: pmId, email: `${pmId}@example.test`, roles: ['support'] });

beforeAll(async () => {
  dbs = connectTestDatabases();
  const owner = dbs.owner;
  await owner.insert(schema.user).values([
    { id: opsId, name: 'Ops Manager', email: `${opsId}@example.test` },
    { id: pmId, name: 'Support Person', email: `${pmId}@example.test` },
    { id: customerId, name: 'Existing Customer', email: customerEmail },
  ]);
  await owner.insert(schema.staffRoles).values([
    { userId: opsId, role: 'operations_manager' },
    { userId: pmId, role: 'support' },
  ]);
  await owner.insert(schema.organization).values({ id: orgId, name: 'Customer Org', slug: orgId });
  await owner.insert(schema.member).values({ id: `m_${customerId}`, organizationId: orgId, userId: customerId, role: 'owner' });
  serviceSlug = `monitoring-${sfx}`;
  const [svc] = await owner
    .insert(schema.services)
    .values({
      slug: serviceSlug,
      name: 'Monitoring (test)',
      category: 'core',
      shortDescription: 'test',
      workflowTemplateKey: 'construction_monitoring',
      bookingEnabled: true,
      publicationState: 'published',
    })
    .returning({ id: schema.services.id });
  serviceId = svc!.id;
  const inserted = await owner
    .insert(schema.leads)
    .values([
      {
        contactName: 'Existing Customer',
        email: customerEmail,
        source: 'website_form',
        interestServiceId: serviceId,
        goal: 'build_with_oversight',
        message: 'I want monitoring for my build in Ibadan.',
        context: { marketIds: [], budgetNaira: 45_000_000 },
        status: 'new',
      },
      {
        contactName: 'New Person',
        email: `new_${sfx}@example.test`,
        source: 'quote_request',
        interestServiceId: serviceId,
        goal: 'buy_safely',
        message: 'No account yet.',
        context: { marketIds: [] },
        status: 'new',
      },
      {
        contactName: 'Third Lead',
        email: `third_${sfx}@example.test`,
        source: 'map_scenario',
        goal: 'invest_and_compare',
        context: {},
        status: 'new',
      },
    ])
    .returning({ id: schema.leads.id, email: schema.leads.email });
  leadWithAccount = inserted.find((l) => l.email === customerEmail)!.id;
  leadWithoutAccount = inserted.find((l) => l.email === `new_${sfx}@example.test`)!.id;
});

afterAll(async () => {
  await dbs.close();
});

describe('listing', () => {
  it('filters by search and paginates with a cursor', async () => {
    const first = await listLeads(ops(), { q: sfx, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listLeads(ops(), { q: sfx, limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = new Set([...first.items, ...second.items].map((l) => l.id));
    expect(all.size).toBe(3);
  });

  it('filters unassigned leads', async () => {
    const unassigned = await listLeads(ops(), { q: sfx, assignedToUserId: 'unassigned', limit: 10 });
    expect(unassigned.items.every((l) => l.assignedToUserId === null)).toBe(true);
  });
});

describe('assignment and status', () => {
  it('assigns to an active staff member and rejects non-staff assignees', async () => {
    await expect(
      updateLead(ops(), leadWithAccount, { assignedToUserId: customerId }, { correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const updated = await updateLead(ops(), leadWithAccount, { assignedToUserId: pmId }, { correlationId: 'c' });
    expect(updated.assignedToUserId).toBe(pmId);
    expect(updated.assignedToName).toBe('Support Person');
  });

  it('changes status with an internal note and records an audit entry', async () => {
    const updated = await updateLead(ops(), leadWithAccount, { status: 'qualified', note: 'Spoke on the phone; budget confirmed.' }, { correlationId: 'c' });
    expect(updated.status).toBe('qualified');
    const detail = await getLeadDetail(ops(), leadWithAccount);
    expect(detail.notes.map((n) => n.body)).toContain('Spoke on the phone; budget confirmed.');
    expect(detail.notes.every((n) => n.visibility === 'internal')).toBe(true);
    expect(detail.linkedUser?.id).toBe(customerId);
    expect(detail.organizationName).toBeNull();
    expect(detail.budgetNaira).toBe(45_000_000);
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityId, leadWithAccount), eq(schema.auditEvents.action, 'lead.updated')));
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect((audit.at(-1)!.after as { status: string }).status).toBe('qualified');
  });

  it('refuses converted status without the convert action', async () => {
    await expect(updateLead(ops(), leadWithAccount, { status: 'converted' }, { correlationId: 'c' })).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('adds internal notes', async () => {
    const note = await addLeadNote(ops(), leadWithAccount, 'Follow up next week.', { correlationId: 'c' });
    expect(note.visibility).toBe('internal');
    expect(note.authorName).toBe('Ops Manager');
  });
});

describe('conversion', () => {
  it('creates a service request when the email belongs to a customer organisation member', async () => {
    const result = await convertLead(ops(), leadWithAccount, { note: 'Converted after call.' }, { correlationId: 'conv' });
    expect(result.path).toBe('service_request_created');
    expect(result.organizationId).toBe(orgId);
    expect(result.reference).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(result.leadStatus).toBe('converted');

    const [sr] = await dbs.owner.select().from(schema.serviceRequests).where(eq(schema.serviceRequests.id, result.serviceRequestId!));
    expect(sr).toMatchObject({
      organizationId: orgId,
      requestedByUserId: customerId,
      serviceId,
      leadId: leadWithAccount,
      status: 'inquiry',
      description: 'I want monitoring for my build in Ibadan.',
    });
    const [lead] = await dbs.owner.select().from(schema.leads).where(eq(schema.leads.id, leadWithAccount));
    expect(lead).toMatchObject({ status: 'converted', convertedServiceRequestId: result.serviceRequestId, userId: customerId, organizationId: orgId });
    const transitions = await dbs.owner
      .select()
      .from(schema.engagementTransitions)
      .where(eq(schema.engagementTransitions.serviceRequestId, result.serviceRequestId!));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ toStatus: 'inquiry', actorType: 'staff', actorUserId: opsId });
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.aggregateId, result.serviceRequestId!), eq(schema.outboxEvents.eventType, 'service_request.transitioned')));
    expect(outbox).toHaveLength(1);
    const detail = await getLeadDetail(ops(), leadWithAccount);
    expect(detail.convertedReference).toBe(result.reference);
    await expect(convertLead(ops(), leadWithAccount, {}, { correlationId: 'conv2' })).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('queues an invitation and marks the lead contacted when no account matches', async () => {
    const result = await convertLead(ops(), leadWithoutAccount, { serviceSlug }, { correlationId: 'inv' });
    expect(result).toMatchObject({ path: 'invitation_sent', serviceRequestId: null, leadStatus: 'contacted' });
    const [lead] = await dbs.owner.select().from(schema.leads).where(eq(schema.leads.id, leadWithoutAccount));
    expect(lead!.status).toBe('contacted');
    const outbox = await dbs.owner
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.aggregateId, leadWithoutAccount), eq(schema.outboxEvents.eventType, 'lead.invited')));
    expect(outbox).toHaveLength(1);
    const payload = outbox[0]!.payload as { email: string; inviteUrl: string; serviceSlug: string };
    expect(payload.email).toBe(`new_${sfx}@example.test`);
    expect(payload.serviceSlug).toBe(serviceSlug);
    expect(payload.inviteUrl).toContain('/sign-up?next=');
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityId, leadWithoutAccount), eq(schema.auditEvents.action, 'lead.invited')));
    expect(audit).toHaveLength(1);
  });

  it('requires a service to convert', async () => {
    const [third] = await dbs.owner
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(eq(schema.leads.email, `third_${sfx}@example.test`));
    await expect(convertLead(ops(), third!.id, {}, { correlationId: 'c' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('permissions in read models', () => {
  it('lets support read leads but the API layer gates mutations on leads.manage', async () => {
    const detail = await getLeadDetail(supportOnly(), leadWithAccount);
    expect(detail.id).toBe(leadWithAccount);
  });
});

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '@simplexd/db';
import { chartOfAccounts, seedConfigurationDefaults } from '@simplexd/db/seed';
import { connectTestDatabases, uniqueSuffix, type TestDatabases } from '@simplexd/db/testing';
import { AuthorizationError } from '@simplexd/domain/authz';
import {
  computeSlaDueAt,
  createFinanceRuntime,
  createQuote,
  type FinanceActor,
} from '@simplexd/finance';
import { cacheDelete } from '@/lib/cache';
import { documentStage, requirementsForStage } from '@/lib/services/document-requirements';
import type { AdminContext } from '../context';
import { contextFor, identityFor, insertStaffUser } from '../test-support';
import {
  createDocumentRequirement,
  listDocumentRequirements,
  patchDocumentRequirement,
  publicDocumentRequirements,
  requirementsForCustomer,
} from './document-requirements';
import { createQuoteTemplate, listQuoteTemplates, patchQuoteTemplate } from './quote-templates';
import {
  activeReportTemplate,
  createReportTemplate,
  listReportTemplates,
  patchReportTemplate,
} from './report-templates';
import { createSlaPolicy, listSlaPolicies, patchSlaPolicy } from './sla-policies';

/**
 * Quote templates (and their use when drafting a quote), report templates
 * with one active per kind, document requirements filtering, SLA policies
 * and the configuration seed.
 */

let dbs: TestDatabases;
let sfx: string;
let ops: AdminContext;
let pm: AdminContext;
let inspector: AdminContext;
let support: AdminContext;
let serviceId: string;
let otherServiceId: string;
let orgId: string;
let customerId: string;

const users = () => ({
  ops: { id: `tp_ops_${sfx}`, name: 'Ops', email: `tp-ops-${sfx}@example.test` },
  pm: { id: `tp_pm_${sfx}`, name: 'PM', email: `tp-pm-${sfx}@example.test` },
  insp: { id: `tp_insp_${sfx}`, name: 'Inspector', email: `tp-insp-${sfx}@example.test` },
  sup: { id: `tp_sup_${sfx}`, name: 'Support', email: `tp-sup-${sfx}@example.test` },
  cust: { id: `tp_cust_${sfx}`, name: 'Customer', email: `tp-cust-${sfx}@example.test` },
});

async function insertService(slug: string, name: string): Promise<string> {
  const [svc] = await dbs.owner
    .insert(schema.services)
    .values({
      slug,
      name,
      category: 'core',
      shortDescription: 'test',
      workflowTemplateKey: 'due_diligence',
      bookingEnabled: true,
      publicationState: 'published',
      sortOrder: 901,
    })
    .returning({ id: schema.services.id });
  return svc!.id;
}

beforeAll(async () => {
  dbs = connectTestDatabases();
  sfx = uniqueSuffix();
  const u = users();
  await insertStaffUser(dbs.owner, u.ops, ['operations_manager']);
  await insertStaffUser(dbs.owner, u.pm, ['project_manager']);
  await insertStaffUser(dbs.owner, u.insp, ['inspector']);
  await insertStaffUser(dbs.owner, u.sup, ['support']);
  await insertStaffUser(dbs.owner, u.cust, []);
  ops = contextFor(dbs.app, identityFor(u.ops, ['operations_manager']));
  pm = contextFor(dbs.app, identityFor(u.pm, ['project_manager']));
  inspector = contextFor(dbs.app, identityFor(u.insp, ['inspector']));
  support = contextFor(dbs.app, identityFor(u.sup, ['support']));
  serviceId = await insertService(`tpl-svc-${sfx}`, `Template service ${sfx}`);
  otherServiceId = await insertService(`tpl-other-${sfx}`, `Other service ${sfx}`);
  orgId = `tp_org_${sfx}`;
  customerId = u.cust.id;
  await dbs.owner
    .insert(schema.organization)
    .values({ id: orgId, name: 'Template org', slug: orgId });
  await dbs.owner
    .insert(schema.member)
    .values({ id: `m_${customerId}`, organizationId: orgId, userId: customerId, role: 'owner' });
  await dbs.owner
    .insert(schema.ledgerAccounts)
    .values(chartOfAccounts)
    .onConflictDoNothing({ target: schema.ledgerAccounts.code });
});

afterAll(async () => {
  await cacheDelete('services:');
  await closeDb();
  await dbs.close();
});

describe('quote templates', () => {
  it('lets pricing managers create and edit templates, quote issuers read them, and nobody else', async () => {
    await expect(listQuoteTemplates(support)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createQuoteTemplate(pm, {
        serviceId,
        name: 'PM template',
        lines: [{ description: 'x', quantity: '1', unitAmountKobo: '100' }],
        scopeMarkdown: null,
        exclusions: null,
        active: true,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createQuoteTemplate(ops, {
        serviceId,
        name: 'Negative',
        lines: [{ description: 'x', quantity: '1', unitAmountKobo: '-100' }],
        scopeMarkdown: null,
        exclusions: null,
        active: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const t = await createQuoteTemplate(ops, {
      serviceId,
      name: `Standard diligence ${sfx}`,
      lines: [
        { description: 'Document review', quantity: '1', unitAmountKobo: '5000000' },
        { description: 'Site visit', quantity: '2.5', unitAmountKobo: '2000000' },
      ],
      scopeMarkdown: 'One property.',
      exclusions: 'Court fees.',
      active: true,
    });
    expect(t.lines[1]?.amountKobo).toBe('5000000');
    expect(t.subtotalKobo).toBe('10000000');
    expect(t.serviceName).toBe(`Template service ${sfx}`);
    const seen = await listQuoteTemplates(pm, { serviceId });
    expect(seen.map((x) => x.id)).toContain(t.id);
    expect(
      (await listQuoteTemplates(pm, { serviceId: otherServiceId })).map((x) => x.id),
    ).not.toContain(t.id);

    await expect(
      patchQuoteTemplate(ops, t.id, {
        name: 'Renamed',
        reason: 'tidy up',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const patched = await patchQuoteTemplate(ops, t.id, {
      name: `Renamed ${sfx}`,
      reason: 'tidy up',
      expectedUpdatedAt: t.updatedAt,
    });
    expect(patched.name).toBe(`Renamed ${sfx}`);
    const audit = await dbs.owner
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, t.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['quote_template.created', 'quote_template.updated']),
    );
  });

  it('pre-fills a quote from a template while the quote keeps its own edited lines', async () => {
    const [tpl] = await listQuoteTemplates(ops, { serviceId, active: 'true' });
    const [foreign] = await dbs.owner
      .insert(schema.quoteTemplates)
      .values({
        serviceId: otherServiceId,
        name: 'Foreign',
        lines: [{ description: 'y', quantity: '1', unitAmountKobo: '100', amountKobo: '100' }],
      })
      .returning({ id: schema.quoteTemplates.id });
    const [sr] = await dbs.owner
      .insert(schema.serviceRequests)
      .values({
        reference: `SR-T-${sfx.toUpperCase().slice(-8)}`,
        organizationId: orgId,
        requestedByUserId: customerId,
        serviceId,
        title: 'Template quote',
        status: 'triage',
        assignedPmUserId: pm.identity.actor.userId,
      })
      .returning({ id: schema.serviceRequests.id });
    const rt = createFinanceRuntime({
      db: dbs.app,
      appUrl: 'http://localhost:3000',
      appEnv: 'test',
      defaultEnvironment: 'test',
      resolveProvider: async () => null,
    });
    const fa: FinanceActor = {
      actor: ops.identity.actor,
      ctx: ops.identity.ctx,
      correlationId: 'test',
    };

    await expect(
      createQuote(rt, fa, sr!.id, {
        templateId: foreign!.id,
        currency: 'NGN',
        depositBps: 10_000,
        requiresPayment: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Staff started from the template and changed the second line before saving.
    const edited = [
      {
        description: tpl!.lines[0]!.description,
        quantity: '1',
        unitAmountKobo: tpl!.lines[0]!.unitAmountKobo,
      },
      { description: 'Site visit (reduced)', quantity: '1', unitAmountKobo: '1500000' },
    ];
    const quote = await createQuote(rt, fa, sr!.id, {
      templateId: tpl!.id,
      lines: edited,
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
    });
    expect(quote.versions[0]?.lines.map((l) => l.description)).toEqual([
      'Document review',
      'Site visit (reduced)',
    ]);
    expect(quote.versions[0]?.subtotalKobo).toBe('6500000');

    // Editing the template afterwards leaves the drafted quote untouched.
    await patchQuoteTemplate(ops, tpl!.id, {
      lines: [{ description: 'Changed later', quantity: '1', unitAmountKobo: '1' }],
      reason: 'template changed after quote',
      expectedUpdatedAt: (await listQuoteTemplates(ops, { serviceId })).find(
        (x) => x.id === tpl!.id,
      )!.updatedAt,
    });
    const [version] = await dbs.owner
      .select()
      .from(schema.quoteVersions)
      .where(eq(schema.quoteVersions.quoteId, quote.id));
    expect(version?.lines.map((l) => l.description)).toEqual([
      'Document review',
      'Site visit (reduced)',
    ]);

    // With no lines, the template's lines are used.
    const fromTemplate = await createQuote(rt, fa, sr!.id, {
      templateId: tpl!.id,
      currency: 'NGN',
      depositBps: 10_000,
      requiresPayment: true,
    });
    expect(fromTemplate.versions[0]?.lines.map((l) => l.description)).toEqual(['Changed later']);
  });
});

describe('report templates', () => {
  const sections = [
    { key: 'summary', heading: 'Summary', required: true },
    { key: 'findings', heading: 'Findings', guidance: 'Say what was seen.', required: true },
  ];

  it('keeps exactly one active template per kind and records who activated what', async () => {
    await expect(listReportTemplates(support)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createReportTemplate(inspector, {
        kind: 'valuation',
        name: 'x',
        sections,
        limitationsMarkdown: 'No guarantee is given.',
        active: true,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const t1 = await createReportTemplate(pm, {
      kind: 'valuation',
      name: `Valuation A ${sfx}`,
      sections,
      limitationsMarkdown: 'Scope and limitations: this is not a valuation certificate.',
      active: true,
    });
    const t2 = await createReportTemplate(pm, {
      kind: 'valuation',
      name: `Valuation B ${sfx}`,
      sections,
      limitationsMarkdown: 'Scope and limitations: this is not a valuation certificate.',
      active: true,
    });
    const activeNow = async () =>
      dbs.owner
        .select({ id: schema.reportTemplates.id })
        .from(schema.reportTemplates)
        .where(
          and(
            eq(schema.reportTemplates.kind, 'valuation'),
            eq(schema.reportTemplates.active, true),
          ),
        );
    expect((await activeNow()).map((r) => r.id)).toEqual([t2.id]);
    expect((await activeReportTemplate(dbs.owner, 'valuation'))?.id).toBe(t2.id);

    const t1Now = (await listReportTemplates(inspector, { kind: 'valuation' })).find(
      (t) => t.id === t1.id,
    )!;
    expect(t1Now.active).toBe(false);
    expect(t1Now.version).toBe(t1.version + 1);
    await expect(
      patchReportTemplate(pm, t1.id, {
        active: true,
        expectedVersion: t1.version,
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await patchReportTemplate(pm, t1.id, {
      active: true,
      expectedVersion: t1Now.version,
      reason: 'switch back',
    });
    expect((await activeNow()).map((r) => r.id)).toEqual([t1.id]);
    await expect(
      patchReportTemplate(pm, t1.id, {
        sections: [
          { key: 'a', heading: 'A', required: true },
          { key: 'a', heading: 'B', required: false },
        ],
        expectedVersion: t1Now.version + 1,
        reason: 'dup',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('seeds one active template per core report kind and requirements per core service, idempotently', async () => {
    const first = await seedConfigurationDefaults(dbs.owner);
    const second = await seedConfigurationDefaults(dbs.owner);
    expect(second).toEqual({ reportTemplatesInserted: 0, documentRequirementsInserted: 0 });
    for (const kind of [
      'progress',
      'inspection',
      'virtual_inspection',
      'diligence_memo',
      'closing_pack',
      'search_outcome',
    ] as const) {
      const active = await activeReportTemplate(dbs.owner, kind);
      expect(active, kind).not.toBeNull();
      expect(active!.sections.length).toBeGreaterThan(3);
      expect(active!.limitationsMarkdown).toContain('not a legal opinion');
    }
    expect(first.reportTemplatesInserted).toBeLessThanOrEqual(6);
  });
});

describe('document requirements', () => {
  it('filters by service, stage and sensitivity for customers and the public', async () => {
    await expect(
      createDocumentRequirement(pm, {
        serviceId,
        name: 'x',
        description: null,
        stage: null,
        required: true,
        sensitive: false,
        active: true,
        sortOrder: 0,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createDocumentRequirement(ops, {
        serviceId,
        name: 'Closed stage',
        description: null,
        stage: 'completed',
        required: true,
        sensitive: false,
        active: true,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const title = await createDocumentRequirement(ops, {
      serviceId,
      name: `Title copy ${sfx}`,
      description: 'For searches',
      stage: 'triage',
      required: true,
      sensitive: false,
      active: true,
      sortOrder: 10,
    });
    const id = await createDocumentRequirement(ops, {
      serviceId,
      name: `Photo ID ${sfx}`,
      description: 'Only if the registry asks',
      stage: 'in_progress',
      required: false,
      sensitive: true,
      active: true,
      sortOrder: 20,
    });
    const global = await createDocumentRequirement(ops, {
      serviceId: null,
      name: `Photos ${sfx}`,
      description: null,
      stage: null,
      required: false,
      sensitive: false,
      active: true,
      sortOrder: 1,
    });
    const inactive = await createDocumentRequirement(ops, {
      serviceId,
      name: `Old form ${sfx}`,
      description: null,
      stage: null,
      required: true,
      sensitive: false,
      active: false,
      sortOrder: 2,
    });
    await createDocumentRequirement(ops, {
      serviceId: otherServiceId,
      name: `Survey ${sfx}`,
      description: null,
      stage: 'triage',
      required: true,
      sensitive: false,
      active: true,
      sortOrder: 1,
    });

    await cacheDelete('services:requirements:');
    const pub = await publicDocumentRequirements(serviceId);
    const pubIds = pub.map((r) => r.id);
    expect(pubIds).toContain(title.id);
    expect(pubIds).toContain(global.id);
    expect(pubIds).not.toContain(id.id);
    expect(pubIds).not.toContain(inactive.id);
    expect(JSON.stringify(pub)).not.toContain(`Photo ID ${sfx}`);

    const identity = identityFor({ id: customerId, name: 'Customer', email: 'c@example.test' }, []);
    identity.ctx.organizationId = orgId;
    const all = await requirementsForCustomer(identity, serviceId);
    const atTriage = requirementsForStage(all, {
      serviceId,
      stage: 'triage',
      includeSensitive: true,
    });
    expect(atTriage.now.map((r) => r.id)).toEqual([global.id, title.id]);
    expect(atTriage.later.map((r) => r.id)).toEqual([id.id]);
    const paused = documentStage('paused', [
      { fromStatus: 'triage', toStatus: 'paused', createdAt: '2026-09-01T00:00:00Z' },
      { fromStatus: 'in_progress', toStatus: 'paused', createdAt: '2026-09-05T00:00:00Z' },
    ]);
    expect(
      requirementsForStage(all, { serviceId, stage: paused, includeSensitive: true }).now.map(
        (r) => r.id,
      ),
    ).toEqual([global.id, title.id, id.id]);

    const listed = await listDocumentRequirements(pm, { serviceId: 'all' });
    expect(listed.every((r) => r.serviceId === null)).toBe(true);
    const patched = await patchDocumentRequirement(ops, id.id, {
      required: true,
      expectedVersion: id.version,
      reason: 'registry now insists',
    });
    expect(patched.required).toBe(true);
    expect(patched.version).toBe(id.version + 1);
    await expect(
      patchDocumentRequirement(ops, id.id, {
        required: false,
        expectedVersion: id.version,
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
});

describe('SLA policies', () => {
  it('allows one active policy per service and stage and triage prefers the service-specific one', async () => {
    await expect(
      createSlaPolicy(support, {
        serviceId: null,
        stage: 'triage',
        targetHours: 1,
        businessHoursOnly: true,
        escalateToRole: null,
        active: true,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const specific = await createSlaPolicy(ops, {
      serviceId,
      stage: 'triage',
      targetHours: 8,
      businessHoursOnly: false,
      escalateToRole: 'operations_manager',
      active: true,
    });
    await expect(
      createSlaPolicy(ops, {
        serviceId,
        stage: 'triage',
        targetHours: 9,
        businessHoursOnly: false,
        escalateToRole: null,
        active: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const spare = await createSlaPolicy(ops, {
      serviceId,
      stage: 'triage',
      targetHours: 9,
      businessHoursOnly: false,
      escalateToRole: null,
      active: false,
    });
    await expect(
      patchSlaPolicy(ops, spare.id, {
        active: true,
        reason: 'swap',
        expectedUpdatedAt: spare.updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // A global triage policy may already exist in the shared database; make sure one is present.
    const globals = (await listSlaPolicies(pm)).filter(
      (p) => p.serviceId === null && p.stage === 'triage' && p.active,
    );
    if (globals.length === 0) {
      await createSlaPolicy(ops, {
        serviceId: null,
        stage: 'triage',
        targetHours: 48,
        businessHoursOnly: true,
        escalateToRole: null,
        active: true,
      });
    }
    const now = new Date('2026-09-23T09:00:00Z');
    const due = await dbs.owner.transaction((tx) => computeSlaDueAt(tx, serviceId, 'triage', now));
    expect(due.policyId).toBe(specific.id);
    expect(due.dueAt?.toISOString()).toBe('2026-09-23T17:00:00.000Z');
    const otherDue = await dbs.owner.transaction((tx) =>
      computeSlaDueAt(tx, otherServiceId, 'triage', now),
    );
    expect(otherDue.policyId).not.toBe(specific.id);

    const off = await patchSlaPolicy(ops, specific.id, {
      active: false,
      reason: 'retire',
      expectedUpdatedAt: specific.updatedAt,
    });
    expect(off.active).toBe(false);
    const on = await patchSlaPolicy(ops, spare.id, {
      active: true,
      reason: 'swap',
      expectedUpdatedAt: spare.updatedAt,
    });
    expect(on.active).toBe(true);
    const after = await dbs.owner.transaction((tx) =>
      computeSlaDueAt(tx, serviceId, 'triage', now),
    );
    expect(after.policyId).toBe(spare.id);
  });
});

import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ROLES, storageStateFor, type DemoRole } from '../global-setup';

/**
 * Acceptance scenario 3 as one HTTP journey against a running server: a
 * customer requests due diligence, staff triage it and issue a versioned
 * quote, the customer accepts and pays with the labelled development payment
 * adapter, the server verifies and settles once, a project manager drafts the
 * memorandum, a different named professional reviews and releases it, and the
 * customer reads it. Another customer organisation is refused every id along
 * the way. Runs once per Playwright project; each run creates its own records.
 */

type Json = Record<string, unknown>;

async function api<T = Json>(
  ctx: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  expectedStatus = 200,
): Promise<T> {
  const res = await ctx.fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status(), `${method} ${path} → ${text.slice(0, 300)}`).toBe(expectedStatus);
  return (text ? JSON.parse(text) : {}) as T;
}

async function deniedFor(
  ctx: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  body: unknown = {},
) {
  const res = await ctx.fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    data: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  expect([403, 404], `${method} ${path} answered ${res.status()}`).toContain(res.status());
}

test.describe.configure({ mode: 'serial' });

test('due diligence: request → quote → payment → reviewed memorandum, isolated per organisation', async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const contexts: Partial<Record<DemoRole, APIRequestContext>> = {};
  for (const role of ['owner', 'otherOwner', 'pm', 'admin'] as const) {
    contexts[role] = await playwright.request.newContext({
      baseURL,
      storageState: storageStateFor(role),
      extraHTTPHeaders: { origin },
    });
  }
  const owner = contexts.owner!;
  const other = contexts.otherOwner!;
  const pm = contexts.pm!;
  const admin = contexts.admin!;

  try {
    // Staff ids come from the directory, never from hard-coded values.
    const directory = await api<{ items: { id: string; email: string }[] }>(
      pm,
      'GET',
      '/api/v1/admin/staff-directory',
    );
    const pmId = directory.items.find((s) => s.email === ROLES.pm)?.id;
    const adminId = directory.items.find((s) => s.email === ROLES.admin)?.id;
    expect(pmId, 'project manager in staff directory').toBeTruthy();
    expect(adminId, 'administrator in staff directory').toBeTruthy();

    // 1. Customer requests due diligence.
    const request = await api<{ id: string; version: number; status: string }>(
      owner,
      'POST',
      '/api/v1/service-requests',
      {
        serviceSlug: 'due-diligence',
        title: 'E2E diligence on a Lekki plot',
        description:
          'Please verify title, survey and encumbrances on a 600 square metre plot before we pay a deposit.',
      },
      201,
    );
    expect(request.status).toBe('inquiry');
    await deniedFor(other, 'GET', `/api/v1/service-requests/${request.id}`);

    // 2. Staff triage and a versioned quote.
    const triaged = await api<{ status: string; version: number }>(
      pm,
      'POST',
      `/api/v1/service-requests/${request.id}/triage`,
      { assignedPmUserId: pmId, priority: 2, expectedVersion: request.version },
    );
    expect(triaged.status).toBe('triage');

    const draft = await api<{ id: string; status: string; versions: { id: string }[] }>(
      pm,
      'POST',
      `/api/v1/service-requests/${request.id}/quotes`,
      {
        lines: [
          { description: 'Title and document review', quantity: '1', unitAmountKobo: '10000000' },
          { description: 'Site verification visit', quantity: '1', unitAmountKobo: '5000000' },
        ],
        currency: 'NGN',
        depositBps: 10_000,
        requiresPayment: true,
        scopeMarkdown: 'One property, registry search and one site visit.',
      },
      201,
    );
    expect(draft.status).toBe('draft');
    const issued = await api<{ status: string; versions: { id: string }[] }>(
      pm,
      'POST',
      `/api/v1/quotes/${draft.id}/issue`,
      { validDays: 7 },
    );
    expect(issued.status).toBe('issued');
    const quoteVersionId = issued.versions[0]!.id;

    // The other organisation sees nothing.
    await deniedFor(other, 'GET', `/api/v1/quotes/${draft.id}`);
    await deniedFor(other, 'POST', `/api/v1/quotes/${draft.id}/accept`, {
      quoteVersionId,
      signatureName: 'Other Owner',
      termsVersion: '2026-09',
      acceptTerms: true,
    });

    // 3. Customer accepts with a signature; the invoice is issued.
    const accepted = await api<{
      quote: { status: string };
      engagementStatus: string;
      invoiceId: string;
    }>(owner, 'POST', `/api/v1/quotes/${draft.id}/accept`, {
      quoteVersionId,
      signatureName: 'Demo Customer Owner',
      termsVersion: '2026-09',
      acceptTerms: true,
    });
    expect(accepted.quote.status).toBe('accepted');
    expect(accepted.engagementStatus).toBe('awaiting_payment');
    expect(accepted.invoiceId).toBeTruthy();
    await deniedFor(other, 'GET', `/api/v1/invoices/${accepted.invoiceId}`);

    // 4. Payment with the development adapter (labelled; never a real gateway).
    const attempt = await api<{
      id: string;
      reference: string;
      authorizationUrl: string;
      developmentAdapter: boolean;
      status: string;
    }>(owner, 'POST', `/api/v1/invoices/${accepted.invoiceId}/payment-attempts`, {}, 201);
    expect(attempt.developmentAdapter).toBe(true);
    expect(attempt.authorizationUrl).toContain('/dev/paystack-checkout');

    // A redirect is not a settlement: verifying before the provider reports keeps it pending.
    const pending = await api<{ decision: string; invoiceStatus: string }>(
      owner,
      'POST',
      `/api/v1/payment-attempts/${attempt.id}/verify`,
    );
    expect(pending.decision).toBe('keep_pending');
    expect(pending.invoiceStatus).toBe('issued');

    const simulated = await owner.post('/dev/paystack-checkout/simulate', {
      form: { reference: attempt.reference, outcome: 'success' },
      maxRedirects: 0,
    });
    expect(simulated.status(), 'development checkout simulation').toBe(303);
    expect(simulated.headers()['location']).toContain('/api/v1/payment-attempts/callback');

    const settled = await api<{ decision: string; invoiceStatus: string; receiptNumber: string }>(
      owner,
      'POST',
      `/api/v1/payment-attempts/${attempt.id}/verify`,
    );
    expect(settled.decision).toBe('settle');
    expect(settled.invoiceStatus).toBe('paid');
    expect(settled.receiptNumber).toMatch(/^RCT-/);

    // Verifying again changes nothing and never double-allocates.
    const again = await api<{ decision: string; receiptNumber: string }>(
      owner,
      'POST',
      `/api/v1/payment-attempts/${attempt.id}/verify`,
    );
    expect(again.decision).toBe('no_change');
    expect(again.receiptNumber).toBe(settled.receiptNumber);

    const invoice = await api<{ status: string; balanceKobo: string }>(
      owner,
      'GET',
      `/api/v1/invoices/${accepted.invoiceId}`,
    );
    expect(invoice.status).toBe('paid');
    expect(invoice.balanceKobo).toBe('0');
    const requestNow = await api<{ status: string }>(
      owner,
      'GET',
      `/api/v1/service-requests/${request.id}`,
    );
    expect(requestNow.status).toBe('in_progress');

    // 5. Memorandum drafted by the project manager, reviewed and released by a
    // different named professional, then read by the customer only.
    const memberships = await api<{ items: { organizationId: string }[] }>(
      owner,
      'GET',
      '/api/v1/me/organizations',
    );
    const organizationId = memberships.items[0]!.organizationId;
    const project = await api<{ id: string }>(
      pm,
      'POST',
      '/api/v1/projects',
      {
        organizationId,
        name: 'E2E diligence engagement',
        kind: 'other',
        serviceRequestId: request.id,
        pmUserId: pmId,
      },
      201,
    );
    const report = await api<{ id: string; version: number; status: string }>(
      pm,
      'POST',
      `/api/v1/projects/${project.id}/reports`,
      {
        kind: 'diligence_memo',
        title: 'Due diligence memorandum',
        serviceRequestId: request.id,
        initialRevision: {
          summary: 'Title chain verified at the registry; survey plan matches the parcel.',
          bodyMarkdown:
            '## Findings\n\nRegistry search completed. No encumbrance registered.\n\n## Recommendation\n\nProceed subject to a physical boundary confirmation.',
          scopeLimitations:
            'Desk review of registry records and one site visit. Not a legal opinion or guarantee.',
        },
      },
      201,
    );
    expect(report.status).toBe('draft');
    const submitted = await api<{ version: number; status: string }>(
      pm,
      'POST',
      `/api/v1/reports/${report.id}/submit`,
      { namedReviewerUserId: adminId, expectedVersion: report.version },
    );
    expect(submitted.status).toBe('in_review');
    // The customer cannot read an unreleased report.
    await deniedFor(owner, 'GET', `/api/v1/reports/${report.id}`);

    const reviewed = await api<{ version: number; status: string }>(
      admin,
      'POST',
      `/api/v1/reports/${report.id}/review`,
      { decision: 'approved', expectedVersion: submitted.version },
    );
    const released = await api<{ status: string; customerVisible: boolean }>(
      admin,
      'POST',
      `/api/v1/reports/${report.id}/release`,
      { expectedVersion: reviewed.version },
    );
    expect(released.status).toBe('released');
    expect(released.customerVisible).toBe(true);

    const customerView = await api<{ status: string; namedReviewer: unknown }>(
      owner,
      'GET',
      `/api/v1/reports/${report.id}`,
    );
    expect(customerView.status).toBe('released');
    await deniedFor(other, 'GET', `/api/v1/reports/${report.id}`);
    await deniedFor(other, 'GET', `/api/v1/projects/${project.id}`);
  } finally {
    await Promise.all(Object.values(contexts).map((c) => c?.dispose()));
  }
});

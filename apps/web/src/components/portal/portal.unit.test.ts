import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileDto, InvoiceDto, QuoteDto, WorkOrderDto } from '@simplexd/contracts';
import { ToastProvider } from '@simplexd/ui';
import { ErrorState, NotAvailable } from './error-state';
import { FileStatusBadge } from './file-status';
import { FilesPanel } from './files-panel';
import { InvoicePay } from './invoice-pay';
import { NotesPanel } from './notes-panel';
import { PaymentOutcome } from './payment-outcome';
import { QuoteCard } from './quote-panel';
import { StartConversation } from './start-conversation';
import { Timeline } from './timeline';
import { WorkOrderActions, workOrderActionsFor, workOrderNextStep } from './maintenance';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/portal',
  useSearchParams: () => new URLSearchParams(),
}));

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const render = (element: ReactElement): string =>
  renderRaw(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ToastProvider, null, element),
    ),
  )
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const ZONE = 'Africa/Lagos';

function quote(overrides: Partial<QuoteDto> = {}): QuoteDto {
  const v1 = {
    id: '00000000-0000-4000-8000-000000000011',
    version: 1,
    lines: [
      {
        description: 'Title search',
        quantity: '1',
        unitAmountKobo: '35000000',
        amountKobo: '35000000',
      },
    ],
    subtotalKobo: '35000000',
    taxKobo: '0',
    totalKobo: '35000000',
    currency: 'NGN',
    scopeMarkdown: 'Registry search.',
    exclusions: null,
    validUntil: '2099-01-01T00:00:00.000Z',
    feeBasis: null,
    taxTreatmentKey: null,
    issuedAt: '2026-09-23T08:00:00.000Z',
    createdAt: '2026-09-23T08:00:00.000Z',
  };
  const v2 = {
    ...v1,
    id: '00000000-0000-4000-8000-000000000012',
    version: 2,
    totalKobo: '50000000',
  };
  return {
    id: '00000000-0000-4000-8000-000000000001',
    serviceRequestId: '00000000-0000-4000-8000-000000000002',
    organizationId: 'org_a',
    status: 'issued',
    currentVersion: 2,
    versions: [v1, v2],
    acceptance: null,
    invoiceId: null,
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
    ...overrides,
  };
}

function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    number: 'INV-2026-0001',
    organizationId: 'org_a',
    kind: 'service',
    status: 'issued',
    serviceRequestId: null,
    quoteVersionId: null,
    customerUserId: null,
    currency: 'NGN',
    subtotalKobo: '50000000',
    taxKobo: '0',
    withholdingKobo: '0',
    totalKobo: '50000000',
    amountPaidKobo: '0',
    amountCreditedKobo: '0',
    balanceKobo: '50000000',
    taxTreatmentKey: null,
    dueDate: '2026-09-30',
    issuedAt: '2026-09-23T08:00:00.000Z',
    paidAt: null,
    voidedAt: null,
    voidReason: null,
    notes: null,
    installmentPlan: null,
    lines: [],
    version: 1,
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
    ...overrides,
  } as InvoiceDto;
}

function file(overrides: Partial<FileDto> = {}): FileDto {
  return {
    id: '00000000-0000-4000-8000-000000000004',
    organizationId: 'org_a',
    ownerUserId: 'u1',
    purpose: 'org_document',
    status: 'clean',
    originalName: 'survey-plan.pdf',
    declaredMime: 'application/pdf',
    detectedMime: 'application/pdf',
    sizeBytes: 2048,
    checksumSha256: null,
    entityType: 'service_request',
    entityId: '00000000-0000-4000-8000-000000000002',
    uploadKind: 'single',
    sensitive: false,
    isPublicApproved: false,
    variants: [],
    statusReason: null,
    scannedAt: null,
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
    ...overrides,
  };
}

describe('QuoteCard', () => {
  it('shows the current version with accept (signature flow) and reject, and keeps superseded versions', () => {
    const html = render(createElement(QuoteCard, { quote: quote(), zone: ZONE, canAccept: true }));
    expect(html).toContain('Quote v2');
    expect(html).toContain('₦500,000.00');
    expect(html).toContain('Accept quote v2');
    expect(html).toContain('Reject with reason');
    expect(html).toContain('1 earlier version (superseded)');
    expect(html).toContain('₦350,000.00');
  });

  it('explains why acceptance is unavailable instead of rendering a dead button', () => {
    const html = render(
      createElement(QuoteCard, {
        quote: quote(),
        zone: ZONE,
        canAccept: false,
        cannotAcceptReason: 'Accepting a quote needs an owner or approver of this organisation.',
      }),
    );
    expect(html).not.toContain('Accept quote v2');
    expect(html).toContain('Acceptance not available');
    expect(html).toContain('needs an owner or approver');
  });

  it('does not offer acceptance once the validity date has passed', () => {
    const q = quote();
    q.versions[1]!.validUntil = '2020-01-01T00:00:00.000Z';
    const html = render(createElement(QuoteCard, { quote: q, zone: ZONE, canAccept: true }));
    expect(html).toContain('Validity passed');
    expect(html).not.toContain('Accept quote v2');
    expect(html).toContain('ask the team to re-issue it');
  });

  it('shows the recorded acceptance and links the invoice raised on acceptance', () => {
    const html = render(
      createElement(QuoteCard, {
        quote: quote({
          status: 'accepted',
          invoiceId: '00000000-0000-4000-8000-000000000003',
          acceptance: {
            quoteVersionId: '00000000-0000-4000-8000-000000000012',
            acceptedByUserId: 'u1',
            acceptedAt: '2026-09-23T09:00:00.000Z',
            signatureName: 'Ada Owner',
            termsVersion: 'customer-terms-2026-09',
          },
        }),
        zone: ZONE,
        canAccept: true,
      }),
    );
    expect(html).toContain('accepted by Ada Owner');
    expect(html).toContain('terms customer-terms-2026-09');
    expect(html).not.toContain('Accept quote');
    expect(html).toContain('/portal/invoices/00000000-0000-4000-8000-000000000003');
  });
});

describe('InvoicePay', () => {
  it('offers payment of the outstanding balance', () => {
    const html = render(createElement(InvoicePay, { invoice: invoice(), canPay: true }));
    expect(html).toContain('Pay ₦500,000.00');
  });

  it('explains a missing right instead of showing a dead pay button', () => {
    const html = render(
      createElement(InvoicePay, {
        invoice: invoice(),
        canPay: false,
        cannotPayReason: 'Paying an invoice is blocked while support impersonation is active.',
      }),
    );
    expect(html).not.toContain('Pay ₦');
    expect(html).toContain('Payment not available');
    expect(html).toContain('impersonation');
  });

  it('renders nothing for a paid invoice', () => {
    const html = render(
      createElement(InvoicePay, {
        invoice: invoice({ status: 'paid', balanceKobo: '0', amountPaidKobo: '50000000' }),
        canPay: true,
      }),
    );
    // Only the toast viewport from the test wrapper remains: no pay control at all.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Pay ');
  });
});

describe('PaymentOutcome', () => {
  it('starts by verifying with the provider, never by trusting the redirect', () => {
    const html = render(
      createElement(PaymentOutcome, {
        attemptId: '00000000-0000-4000-8000-000000000005',
        reference: 'SXD-ABC',
      }),
    );
    expect(html).toContain('Verifying reference SXD-ABC with the payment provider');
    expect(html).not.toContain('Payment received');
  });
});

describe('File states', () => {
  it.each([
    ['scanning', 'Scanning'],
    ['uploaded', 'Queued for scanning'],
    ['clean', 'Scanned clean'],
    ['rejected', 'Rejected'],
    ['infected', 'Blocked: malware'],
    ['scan_failed', 'Scan failed'],
  ])('labels %s with words, not colour alone', (status, label) => {
    const html = render(
      createElement(FileStatusBadge, {
        fileId: '00000000-0000-4000-8000-000000000004',
        status,
        reason: status === 'rejected' ? 'content does not match the declared type' : null,
        poll: false,
      }),
    );
    expect(html).toContain(label);
    if (status === 'rejected') expect(html).toContain('content does not match the declared type');
  });

  it('lists files with signed-download controls and the uploader when allowed', () => {
    const html = render(
      createElement(FilesPanel, {
        files: [
          file(),
          file({
            id: '00000000-0000-4000-8000-000000000006',
            status: 'infected',
            originalName: 'bad.pdf',
          }),
        ],
        entityType: 'service_request',
        entityId: '00000000-0000-4000-8000-000000000002',
        purpose: 'org_document',
        zone: ZONE,
        canUpload: true,
      }),
    );
    expect(html).toContain('survey-plan.pdf');
    expect(html).toContain('Scanned clean');
    expect(html).toContain('Blocked: malware');
    expect(html).toContain('Upload files');
    expect(html).toContain('Download survey-plan.pdf');
  });

  it('explains why uploading is unavailable', () => {
    const html = render(
      createElement(FilesPanel, {
        files: [],
        entityType: 'service_request',
        entityId: '00000000-0000-4000-8000-000000000002',
        purpose: 'org_document',
        zone: ZONE,
        canUpload: false,
        cannotUploadReason: 'This request is closed; documents are read-only.',
      }),
    );
    expect(html).toContain('This request is closed; documents are read-only.');
    expect(html).toContain('No files yet');
  });
});

describe('NotesPanel', () => {
  const notes = [
    {
      id: '00000000-0000-4000-8000-000000000007',
      body: 'Please bring the survey plan.',
      visibility: 'customer' as const,
      authorName: 'Demo PM',
      createdAt: '2026-09-23T08:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000008',
      body: 'Inspector: gate code 1234.',
      visibility: 'all' as const,
      authorName: 'Ada Owner',
      createdAt: '2026-09-23T09:00:00.000Z',
    },
  ];

  it('shows who can read each note and lets the author choose customer or all', () => {
    const html = render(
      createElement(NotesPanel, {
        entityType: 'service_request',
        entityId: '00000000-0000-4000-8000-000000000002',
        notes,
        zone: ZONE,
      }),
    );
    expect(html).toContain('Please bring the survey plan.');
    expect(html).toContain('You and the SimplexD team');
    expect(html).toContain('Team and assigned specialists');
    expect(html).toContain('Who can read this note');
    expect(html).toContain('value="customer"');
    expect(html).toContain('value="all"');
    expect(html).not.toContain('value="internal"');
  });

  it('is read-only with a reason when the record is closed', () => {
    const html = render(
      createElement(NotesPanel, {
        entityType: 'project',
        entityId: '00000000-0000-4000-8000-000000000002',
        notes: [],
        zone: ZONE,
        readOnly: true,
        readOnlyReason: 'This project is closed; notes are read-only.',
      }),
    );
    expect(html).toContain('This project is closed; notes are read-only.');
    expect(html).not.toContain('Add note');
  });
});

describe('StartConversation', () => {
  const base = {
    entityType: 'service_request' as const,
    entityId: '00000000-0000-4000-8000-000000000002',
    subject: 'SR-2026-000002: Diligence',
    canSend: true,
  };
  it('links to an existing conversation instead of creating another', () => {
    const html = render(
      createElement(StartConversation, {
        ...base,
        contact: { id: 'pm1', name: 'Demo PM' },
        existingConversationId: '00000000-0000-4000-8000-000000000009',
      }),
    );
    expect(html).toContain('/portal/messages/00000000-0000-4000-8000-000000000009');
    expect(html).toContain('Open the conversation');
  });
  it('names the assigned contact', () => {
    const html = render(
      createElement(StartConversation, {
        ...base,
        contact: { id: 'pm1', name: 'Demo PM' },
        existingConversationId: null,
      }),
    );
    expect(html).toContain('Message Demo PM');
  });
  it('explains that messaging waits for an assigned contact', () => {
    const html = render(
      createElement(StartConversation, { ...base, contact: null, existingConversationId: null }),
    );
    expect(html).toContain('Messaging opens once a project manager is assigned');
    expect(html).not.toContain('<button');
  });
});

describe('Maintenance work orders', () => {
  const wo = (status: WorkOrderDto['status']) => ({
    id: '00000000-0000-4000-8000-000000000010',
    title: 'Leaking tap',
    status,
    version: 3,
    estimateKobo: '8500000',
    approvedAmountKobo: null,
    actualCostKobo: null,
  });

  it('offers only the transitions the owner may take', () => {
    const rights = { canApprove: true, canRequest: true };
    expect(workOrderActionsFor({ status: 'awaiting_approval' }, rights)).toEqual([
      'approve',
      'reject',
      'cancel',
    ]);
    expect(workOrderActionsFor({ status: 'completed' }, rights)).toEqual(['verify']);
    expect(workOrderActionsFor({ status: 'requested' }, rights)).toEqual(['cancel']);
    expect(workOrderActionsFor({ status: 'in_progress' }, rights)).toEqual([]);
    expect(
      workOrderActionsFor(
        { status: 'awaiting_approval' },
        { canApprove: false, canRequest: false },
      ),
    ).toEqual([]);
  });

  it('renders approve/reject for an estimate and a next-step note otherwise', () => {
    const awaiting = render(
      createElement(WorkOrderActions, {
        workOrder: wo('awaiting_approval'),
        canApprove: true,
        canRequest: true,
      }),
    );
    expect(awaiting).toContain('Approve cost');
    expect(awaiting).toContain('Reject estimate');
    const approved = render(
      createElement(WorkOrderActions, {
        workOrder: wo('approved'),
        canApprove: true,
        canRequest: true,
      }),
    );
    expect(approved).not.toContain('<button');
    expect(approved).toContain(workOrderNextStep('approved'));
  });
});

describe('ErrorState and Timeline', () => {
  it('always shows the correlation id for support', () => {
    const html = render(
      createElement(ErrorState, {
        title: 'Could not accept',
        message: 'A newer version was issued.',
        correlationId: 'corr-123',
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Reference for support');
    expect(html).toContain('corr-123');
  });

  it('states a missing dependency honestly', () => {
    const html = render(
      createElement(NotAvailable, { what: 'Card payments', reason: 'Paystack is not configured.' }),
    );
    expect(html).toContain('Card payments is not available yet.');
    expect(html).toContain('Paystack is not configured.');
  });

  it('renders timeline events newest first with explicit dates', () => {
    const html = render(
      createElement(Timeline, {
        zone: ZONE,
        events: [
          {
            id: 'a',
            at: '2026-09-23T10:00:00.000Z',
            title: 'Budget version 1 approved',
            detail: null,
            kind: 'budget',
          },
          {
            id: 'b',
            at: '2026-09-22T10:00:00.000Z',
            title: 'Project opened',
            detail: 'Duplex',
            kind: 'project',
          },
        ],
      }),
    );
    expect(html.indexOf('Budget version 1 approved')).toBeLessThan(html.indexOf('Project opened'));
    expect(html).toContain('23 Sep 2026');
  });
});

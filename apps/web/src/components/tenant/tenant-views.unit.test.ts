import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToString as renderRaw } from 'react-dom/server';
import type { LeaseBalanceDto, TenantLeaseSummary, WorkOrderDto } from '@simplexd/contracts';
import { AppointmentList } from './appointment-list';
import { ArrearsAgeing, BalanceFigures } from './balance-summary';
import { LeaseCard } from './lease-card';
import { ChargesTable } from './ledger-tables';
import { NoTenancy } from './no-tenancy';
import { TicketList } from './ticket-list';
import { TicketProgress } from './ticket-progress';

/** SSR inserts comment markers between adjacent text nodes; strip them for substring assertions. */
const renderToString = (element: ReactElement): string =>
  renderRaw(element).replace(/<!-- -->/g, '');

const summary: TenantLeaseSummary = {
  lease: {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org_owner',
    propertyId: '22222222-2222-4222-8222-222222222222',
    unitId: null,
    kind: 'residential_annual',
    status: 'active',
    startDate: '2026-09-01',
    endDate: '2027-08-31',
    rentAmountKobo: '240000000',
    rentPeriod: 'annual',
    currency: 'NGN',
    depositKobo: '50000000',
    termsFileId: null,
    academicPeriod: null,
    noticePeriodDays: 30,
    terminatedAt: null,
    terminationReason: null,
    terms: null,
    createdBy: null,
    version: 1,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  },
  property: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Palm Court',
    address: { city: 'Lekki', state: 'Lagos' },
  },
  unit: { id: '33333333-3333-4333-8333-333333333333', label: 'Flat 2B' },
  myRole: 'tenant',
};

const balance: LeaseBalanceDto = {
  leaseId: summary.lease.id,
  currency: 'NGN',
  chargedKobo: '290000000',
  paidKobo: '50000000',
  outstandingKobo: '240000000',
  depositHeldKobo: '50000000',
  nextDue: { dueDate: '2027-09-01', amountKobo: '240000000', invoiceId: null },
  arrears: {
    asOf: '2026-09-23',
    buckets: {
      current: '0',
      days_1_30: '240000000',
      days_31_60: '0',
      days_61_90: '0',
      days_over_90: '0',
    },
    totalOutstandingKobo: '240000000',
    items: [],
  },
};

function ticket(overrides: Partial<WorkOrderDto> = {}): WorkOrderDto {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: 'org_owner',
    propertyId: summary.property.id,
    unitId: null,
    leaseId: summary.lease.id,
    assetId: null,
    estateId: null,
    reportedByUserId: 'tenant-user',
    title: 'Kitchen tap leaking',
    description: 'Under the sink',
    category: 'plumbing',
    priority: 'high',
    status: 'assigned',
    assigneeUserId: 'contractor',
    assigneeName: 'Ade Plumbing',
    estimateKobo: '9900000',
    approvedAmountKobo: null,
    approvedBy: null,
    approvedAt: null,
    actualCostKobo: '8800000',
    expenseJournalId: null,
    slaDueAt: '2026-09-02T09:00:00.000Z',
    slaBreached: true,
    recurring: null,
    completedAt: null,
    verifiedBy: null,
    verifiedAt: null,
    evidence: [],
    version: 3,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('LeaseCard', () => {
  it('shows the tenant terms in naira with explicit dates and no owner-only fields', () => {
    const html = renderToString(createElement(LeaseCard, { summary }));
    expect(html).toContain('Palm Court · Flat 2B');
    expect(html).toContain('₦2,400,000');
    expect(html).toContain('per year');
    expect(html).toContain('1 Sep 2026');
    expect(html).toContain('31 Aug 2027');
    expect(html).toContain('Lekki, Lagos');
    expect(html).toContain('Active');
    expect(html).toContain(`/tenant/lease/${summary.lease.id}`);
    expect(html).not.toContain('org_owner');
    expect(html.toLowerCase()).not.toContain('management fee');
  });
});

describe('Balance views', () => {
  it('renders the figures the API computed and every ageing bucket with words', () => {
    const figures = renderToString(createElement(BalanceFigures, { balance }));
    expect(figures).toContain('Outstanding');
    expect(figures).toContain('₦2,400,000');
    expect(figures).toContain('Due 1 Sep 2027.');
    expect(figures).toContain('Past its due date.');
    const ageing = renderToString(createElement(ArrearsAgeing, { balance }));
    expect(ageing).toContain('<caption');
    expect(ageing).toContain('1–30 days overdue');
    expect(ageing).toContain('More than 90 days overdue');
    expect(ageing).toContain('Total outstanding');
    expect(ageing).toContain('As of 23 Sep 2026');
  });

  it('shows an honest empty message when no charges exist', () => {
    const html = renderToString(createElement(ChargesTable, { charges: [], currency: 'NGN' }));
    expect(html).toContain('No charges have been raised on this lease yet');
  });
});

describe('Tickets', () => {
  it('lists a ticket with status words, priority and the passed response target', () => {
    const html = renderToString(
      createElement(TicketList, { tickets: [ticket()], zone: 'Africa/Lagos' }),
    );
    expect(html).toContain('Kitchen tap leaking');
    expect(html).toContain('Contractor assigned');
    expect(html).toContain('High priority');
    expect(html).toContain('Response target passed');
    expect(html).toContain('/tenant/tickets/44444444-4444-4444-8444-444444444444');
  });

  it('marks the current step for assistive tech and never shows costs', () => {
    const html = renderToString(
      createElement(TicketProgress, { ticket: ticket(), zone: 'Africa/Lagos' }),
    );
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('(current step)');
    expect(html).toContain('Assigned to Ade Plumbing.');
    expect(html).toContain('You reported it');
    expect(html).toContain('1 Sep 2026, 10:00');
    expect(html).not.toContain('₦');
  });

  it('ends the progress early for a cancelled request', () => {
    const html = renderToString(
      createElement(TicketProgress, {
        ticket: ticket({ status: 'cancelled', updatedAt: '2026-09-02T08:00:00.000Z' }),
        zone: 'Africa/Lagos',
      }),
    );
    expect(html).toContain('Cancelled');
    expect(html).toContain('(ended here)');
    expect(html).not.toContain('Work completed');
  });
});

describe('NoTenancy', () => {
  it('explains the invitation path without claiming an error', () => {
    const html = renderToString(
      createElement(NoTenancy, { email: 'tenant@demo.simplexd.local', hasPortal: false }),
    );
    expect(html).toContain('No tenancy on this account yet');
    expect(html).toContain('tenant@demo.simplexd.local');
    expect(html).not.toContain('/portal');
    expect(html).not.toContain('role="alert"');
    const withPortal = renderToString(
      createElement(NoTenancy, { email: 'x@y.z', hasPortal: true }),
    );
    expect(withPortal).toContain('href="/portal"');
  });
});

describe('AppointmentList', () => {
  it('shows Lagos time and the tenant zone when it differs', () => {
    const html = renderToString(
      createElement(AppointmentList, {
        zone: 'Europe/London',
        appointments: [
          {
            id: 'a1',
            kind: 'inspection',
            status: 'confirmed',
            startsAt: '2026-10-01T09:00:00.000Z',
            endsAt: '2026-10-01T10:00:00.000Z',
            topic: 'Quarterly inspection',
            locationNote: 'Gate 2',
          },
        ],
      }),
    );
    expect(html).toContain('Quarterly inspection');
    expect(html).toContain('10:00');
    expect(html).toContain('Your time:');
    expect(html).toContain('Gate 2');
  });
});

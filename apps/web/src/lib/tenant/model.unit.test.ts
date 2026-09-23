import { describe, expect, it } from 'vitest';
import type { TenantLeaseSummary, WorkOrderDto } from '@simplexd/contracts';
import {
  ageingRows,
  canTenantCancel,
  classifyInvitationError,
  formatAddress,
  formatDay,
  formatMoney,
  isOpenTicket,
  maskEmail,
  overdueKobo,
  pickCurrentLease,
  splitAppointments,
  ticketEvents,
  ticketProgress,
  type TenantAppointment,
} from './model';
import { isCurrent, tenantNav } from './nav';

function lease(id: string, status: TenantLeaseSummary['lease']['status'], startDate: string) {
  return {
    lease: { id, status, startDate } as TenantLeaseSummary['lease'],
    property: { id: 'p', name: 'Palm Court', address: null },
    unit: null,
    myRole: 'tenant',
  } as TenantLeaseSummary;
}

function ticket(overrides: Partial<WorkOrderDto> = {}): WorkOrderDto {
  return {
    id: 't1',
    status: 'requested',
    reportedByUserId: 'u1',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    approvedAt: null,
    completedAt: null,
    verifiedAt: null,
    ...overrides,
  } as WorkOrderDto;
}

describe('pickCurrentLease', () => {
  it('prefers a live tenancy over a newer ended one, then the latest start', () => {
    const picked = pickCurrentLease([
      lease('ended', 'ended', '2026-06-01'),
      lease('old-active', 'active', '2025-01-01'),
      lease('new-active', 'active', '2026-01-01'),
    ]);
    expect(picked?.lease.id).toBe('new-active');
    expect(pickCurrentLease([])).toBeNull();
  });
});

describe('money and dates', () => {
  it('formats kobo strings without floating point and never shifts date-only values', () => {
    expect(formatMoney('150000000')).toBe('₦1,500,000');
    expect(formatMoney('12345')).toBe('₦123.45');
    expect(formatMoney('5', 'USD')).toBe('USD 0.05');
    expect(formatMoney(null)).toBe('—');
    expect(formatDay('2026-09-22')).toBe('22 Sep 2026');
    expect(formatDay('2026-01-01')).toBe('1 Jan 2026');
  });

  it('keeps every ageing bucket in order and sums only overdue buckets', () => {
    const arrears = {
      buckets: {
        current: '1000',
        days_1_30: '200',
        days_31_60: '0',
        days_61_90: '0',
        days_over_90: '50',
      },
    };
    expect(ageingRows(arrears).map((r) => r.key)).toEqual([
      'current',
      'days_1_30',
      'days_31_60',
      'days_61_90',
      'days_over_90',
    ]);
    expect(overdueKobo(arrears)).toBe('250');
  });

  it('builds an address from known keys only', () => {
    expect(formatAddress({ line1: '4 Palm Rd', city: 'Lekki', state: 'Lagos', secret: 'x' })).toBe(
      '4 Palm Rd, Lekki, Lagos',
    );
    expect(formatAddress(null)).toBeNull();
  });
});

describe('tickets', () => {
  it('lets a tenant cancel only their own ticket before work starts', () => {
    expect(canTenantCancel(ticket({ status: 'assigned' }), 'u1')).toBe(true);
    expect(canTenantCancel(ticket({ status: 'in_progress' }), 'u1')).toBe(false);
    expect(canTenantCancel(ticket({ status: 'requested', reportedByUserId: 'u2' }), 'u1')).toBe(
      false,
    );
  });

  it('marks the current step and ends early for cancelled tickets', () => {
    const steps = ticketProgress({ status: 'assigned' });
    expect(steps.find((s) => s.state === 'current')?.label).toBe('Contractor assigned');
    expect(steps.filter((s) => s.state === 'done')).toHaveLength(2);
    expect(ticketProgress({ status: 'closed' }).every((s) => s.state === 'done')).toBe(true);
    const cancelled = ticketProgress({ status: 'cancelled' });
    expect(cancelled.map((s) => s.label)).toEqual(['Reported', 'Cancelled']);
    expect(isOpenTicket({ status: 'verified' })).toBe(false);
    expect(isOpenTicket({ status: 'awaiting_approval' })).toBe(true);
  });

  it('lists only dates the record holds, in order', () => {
    const events = ticketEvents(
      ticket({
        status: 'cancelled',
        updatedAt: '2026-09-03T10:00:00.000Z',
        approvedAt: '2026-09-02T10:00:00.000Z',
      }),
    );
    expect(events.map((e) => e.id)).toEqual(['reported', 'approved', 'cancelled']);
  });
});

describe('appointments', () => {
  it('splits upcoming from past and cancelled visits', () => {
    const base: TenantAppointment = {
      id: 'a',
      kind: 'inspection',
      status: 'confirmed',
      startsAt: '2026-10-01T09:00:00.000Z',
      endsAt: '2026-10-01T10:00:00.000Z',
      topic: null,
      locationNote: null,
    };
    const { upcoming, past } = splitAppointments(
      [
        base,
        { ...base, id: 'b', status: 'cancelled' },
        { ...base, id: 'c', startsAt: '2026-08-01T09:00:00Z', endsAt: '2026-08-01T10:00:00Z' },
      ],
      new Date('2026-09-23T00:00:00Z'),
    );
    expect(upcoming.map((a) => a.id)).toEqual(['a']);
    expect(past.map((a) => a.id).sort()).toEqual(['b', 'c']);
  });
});

describe('invitations', () => {
  it('maps accept refusals to honest states', () => {
    expect(classifyInvitationError('not_found', 'invitation not found or already used')).toBe(
      'used_or_revoked',
    );
    expect(classifyInvitationError('conflict', 'this invitation has expired; ask for a new one')).toBe(
      'expired',
    );
    expect(classifyInvitationError('conflict', 'invitation was redeemed concurrently')).toBe(
      'conflict',
    );
    expect(classifyInvitationError('forbidden', 'sign in with the invited e-mail')).toBe(
      'wrong_email',
    );
    expect(classifyInvitationError('internal_error', 'boom')).toBe('error');
    expect(maskEmail('tenant@demo.simplexd.local')).toBe('te***@demo.simplexd.local');
  });
});

describe('navigation', () => {
  it('links only tenant records and marks the lease alias as current', () => {
    const nav = tenantNav('l1', 2);
    expect(nav.map((n) => n.href)).toEqual([
      '/tenant',
      '/tenant/lease/l1',
      '/tenant/balances',
      '/tenant/receipts',
      '/tenant/tickets',
      '/tenant/appointments',
      '/tenant/notices',
    ]);
    expect(nav.every((n) => n.href.startsWith('/tenant'))).toBe(true);
    expect(isCurrent(nav[0]!, '/tenant/balances')).toBe(false);
    expect(isCurrent(nav[1]!, '/tenant/leases/l1')).toBe(true);
    expect(tenantNav(null, 0).some((n) => n.href.startsWith('/tenant/lease/'))).toBe(false);
  });
});

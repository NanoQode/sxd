import { describe, expect, it } from 'vitest';
import {
  anonymousActor,
  authorizeAny,
  authorizeOrg,
  authorizePartner,
  authorizeStaff,
  authorizeTenant,
  type Actor,
} from './policy';
import { STAFF_ROLE_PERMISSIONS } from './roles';

const base: Actor = {
  userId: 'u1',
  staffRoles: [],
  memberships: [],
  activeOrganizationId: null,
  isPartner: false,
  mfaVerified: true,
};

describe('staff role matrix exclusions', () => {
  it('operations manager cannot change payment credentials', () => {
    expect(
      STAFF_ROLE_PERMISSIONS.operations_manager.has('integrations.payment_credentials.manage'),
    ).toBe(false);
    expect(STAFF_ROLE_PERMISSIONS.operations_manager.has('integrations.secrets.rotate')).toBe(
      false,
    );
    const d = authorizeStaff(
      { ...base, staffRoles: ['operations_manager'] },
      'integrations.payment_credentials.manage',
    );
    expect(d.allowed).toBe(false);
  });

  it('inspector cannot release funds or approve their own report', () => {
    const inspector: Actor = { ...base, staffRoles: ['inspector'] };
    expect(authorizeStaff(inspector, 'milestones.finance_authorize').allowed).toBe(false);
    expect(
      authorizeStaff(inspector, 'reports.release', { type: 'report', createdBy: 'u1' }).allowed,
    ).toBe(false);
  });

  it('finance has no sensitive document access', () => {
    const finance: Actor = { ...base, staffRoles: ['finance'] };
    expect(authorizeStaff(finance, 'files.sensitive.read').allowed).toBe(false);
    expect(authorizeStaff(finance, 'finance.reconcile').allowed).toBe(true);
  });

  it('data editor cannot publish own changes and data approver cannot publish own work', () => {
    const editor: Actor = { ...base, staffRoles: ['data_editor'] };
    expect(authorizeStaff(editor, 'market_data.publish').allowed).toBe(false);
    const approver: Actor = { ...base, userId: 'u2', staffRoles: ['data_approver'] };
    const own = authorizeStaff(approver, 'market_data.publish', {
      type: 'observation_interpretation',
      createdBy: 'u2',
    });
    expect(own).toMatchObject({ allowed: false, code: 'own_work' });
    const other = authorizeStaff(approver, 'market_data.publish', {
      type: 'observation_interpretation',
      createdBy: 'u1',
    });
    expect(other.allowed).toBe(true);
  });

  it('content editor has no project or payment access', () => {
    const editor: Actor = { ...base, staffRoles: ['content_editor'] };
    expect(authorizeStaff(editor, 'projects.read_all').allowed).toBe(false);
    expect(authorizeStaff(editor, 'finance.read').allowed).toBe(false);
    expect(authorizeStaff(editor, 'content.publish').allowed).toBe(true);
  });

  it('support cannot read finance and impersonation needs the flag', () => {
    const support: Actor = { ...base, staffRoles: ['support'] };
    expect(authorizeStaff(support, 'finance.read').allowed).toBe(false);
    const admin: Actor = { ...base, staffRoles: ['super_admin'], flags: {} };
    expect(authorizeStaff(admin, 'support.impersonate')).toMatchObject({
      allowed: false,
      code: 'feature_disabled',
    });
    expect(
      authorizeStaff({ ...admin, flags: { 'core.impersonation': true } }, 'support.impersonate')
        .allowed,
    ).toBe(true);
  });

  it('project manager only reaches assigned projects', () => {
    const pm: Actor = { ...base, staffRoles: ['project_manager'] };
    expect(
      authorizeStaff(pm, 'projects.manage', { type: 'project', id: 'p1', assigneeUserIds: ['u9'] }),
    ).toMatchObject({ allowed: false, code: 'not_assigned' });
    expect(
      authorizeStaff(pm, 'projects.manage', { type: 'project', id: 'p1', assigneeUserIds: ['u1'] })
        .allowed,
    ).toBe(true);
  });

  it('requires MFA for sensitive staff permissions and forbids them under impersonation', () => {
    const finance: Actor = { ...base, staffRoles: ['finance'], mfaVerified: false };
    expect(
      authorizeStaff(finance, 'finance.refunds.approve', { type: 'refund', createdBy: 'u3' }),
    ).toMatchObject({ allowed: false, code: 'mfa_required' });
    const impersonating: Actor = {
      ...base,
      staffRoles: ['super_admin'],
      impersonation: { adminUserId: 'u1', expiresAt: '2099-01-01T00:00:00Z' },
    };
    expect(authorizeStaff(impersonating, 'integrations.secrets.rotate')).toMatchObject({
      allowed: false,
      code: 'impersonation_forbidden',
    });
  });

  it('payout second approval must differ from the first approver', () => {
    const finance: Actor = { ...base, staffRoles: ['finance'] };
    expect(
      authorizeStaff(finance, 'finance.payouts.second_approve', {
        type: 'payout',
        attributes: { firstApproverId: 'u1' },
      }),
    ).toMatchObject({ code: 'separation_of_duties' });
    expect(
      authorizeStaff(finance, 'finance.payouts.second_approve', {
        type: 'payout',
        attributes: { firstApproverId: 'u5' },
      }).allowed,
    ).toBe(true);
  });
});

describe('customer organisations', () => {
  const owner: Actor = {
    ...base,
    memberships: [{ organizationId: 'orgA', role: 'owner' }],
    activeOrganizationId: 'orgA',
  };

  it('denies anonymous and cross-organisation access', () => {
    expect(
      authorizeOrg(anonymousActor, 'org.read', { type: 'project', organizationId: 'orgA' }),
    ).toMatchObject({ code: 'unauthenticated' });
    expect(
      authorizeOrg(owner, 'org.read', { type: 'project', organizationId: 'orgB' }),
    ).toMatchObject({ code: 'wrong_organization' });
  });

  it('applies role capabilities', () => {
    const adviser: Actor = {
      ...base,
      memberships: [{ organizationId: 'orgA', role: 'adviser' }],
      activeOrganizationId: 'orgA',
    };
    expect(
      authorizeOrg(adviser, 'org.reports.view', { type: 'report', organizationId: 'orgA' }).allowed,
    ).toBe(true);
    expect(
      authorizeOrg(adviser, 'org.invoices.pay', { type: 'invoice', organizationId: 'orgA' })
        .allowed,
    ).toBe(false);
    expect(
      authorizeOrg(owner, 'org.invoices.pay', { type: 'invoice', organizationId: 'orgA' }).allowed,
    ).toBe(true);
  });

  it('honours explicit grants with levels and expiry', () => {
    const household: Actor = { ...base, userId: 'h1', memberships: [], activeOrganizationId: null };
    const res = {
      type: 'project',
      organizationId: 'orgA',
      grants: [{ userId: 'h1', level: 'comment' as const }],
    };
    expect(authorizeOrg(household, 'org.reports.view', res).allowed).toBe(true);
    expect(authorizeOrg(household, 'org.change_orders.approve', res).allowed).toBe(false);
    const expired = {
      ...res,
      grants: [{ userId: 'h1', level: 'approve' as const, expiresAt: '2000-01-01T00:00:00Z' }],
    };
    expect(authorizeOrg(household, 'org.change_orders.approve', expired)).toMatchObject({
      code: 'grant_expired',
    });
  });

  it('forbids financial approvals while impersonating', () => {
    const imp: Actor = {
      ...owner,
      impersonation: { adminUserId: 'a1', expiresAt: '2099-01-01T00:00:00Z' },
    };
    expect(
      authorizeOrg(imp, 'org.invoices.pay', { type: 'invoice', organizationId: 'orgA' }),
    ).toMatchObject({ code: 'impersonation_forbidden' });
  });
});

describe('tenants and partners', () => {
  it('tenants only see leases they are party to', () => {
    const tenant: Actor = { ...base, userId: 't1' };
    expect(
      authorizeTenant(tenant, 'tenant.lease.view', { type: 'lease', assigneeUserIds: ['t2'] })
        .allowed,
    ).toBe(false);
    expect(
      authorizeTenant(tenant, 'tenant.lease.view', { type: 'lease', assigneeUserIds: ['t1'] })
        .allowed,
    ).toBe(true);
  });

  it('partners only reach invited tenders and assigned work', () => {
    const partner: Actor = { ...base, userId: 'c1', isPartner: true };
    expect(
      authorizePartner(partner, 'partner.bids.submit', { type: 'tender', assigneeUserIds: ['c2'] }),
    ).toMatchObject({ code: 'partner_not_invited' });
    expect(
      authorizePartner(partner, 'partner.bids.submit', { type: 'tender', assigneeUserIds: ['c1'] })
        .allowed,
    ).toBe(true);
    expect(
      authorizePartner({ ...partner, isPartner: false }, 'partner.bids.submit', {
        type: 'tender',
        assigneeUserIds: ['c1'],
      }).allowed,
    ).toBe(false);
  });

  it('authorizeAny returns the first allowing check', () => {
    const owner: Actor = {
      ...base,
      memberships: [{ organizationId: 'orgA', role: 'owner' }],
      activeOrganizationId: 'orgA',
    };
    const d = authorizeAny(owner, [{ staff: 'projects.read_all' }, { org: 'org.read' }], {
      type: 'project',
      organizationId: 'orgA',
    });
    expect(d).toMatchObject({ allowed: true, via: 'org:org.read' });
  });
});

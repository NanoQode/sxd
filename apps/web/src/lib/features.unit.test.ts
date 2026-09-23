import { describe, expect, it } from 'vitest';
import { evaluateFeatureFlags, expansionFlagKey, requireFeature } from './features';
import type { RequestIdentity } from './auth/session';

const rows = [
  { key: 'expansion.tendering', enabled: true, rollout: null },
  { key: 'expansion.procurement', enabled: false, rollout: null },
  { key: 'expansion.short_stay', enabled: true, rollout: { staffOnly: true } },
  { key: 'expansion.student_housing', enabled: true, rollout: { organizationIds: ['org-a'] } },
  { key: 'expansion.portfolio', enabled: true, rollout: { organizationIds: [] } },
];

describe('evaluateFeatureFlags', () => {
  it('turns disabled flags off for everyone, including staff', () => {
    expect(
      evaluateFeatureFlags(rows, { staff: true, organizationId: null })['expansion.procurement'],
    ).toBe(false);
  });

  it('gives staff every enabled flag regardless of rollout', () => {
    const flags = evaluateFeatureFlags(rows, { staff: true, organizationId: null });
    expect(flags['expansion.short_stay']).toBe(true);
    expect(flags['expansion.student_housing']).toBe(true);
  });

  it('applies staff-only and organisation allow-lists to customers and visitors', () => {
    const orgA = evaluateFeatureFlags(rows, { staff: false, organizationId: 'org-a' });
    const orgB = evaluateFeatureFlags(rows, { staff: false, organizationId: 'org-b' });
    const visitor = evaluateFeatureFlags(rows, { staff: false, organizationId: null });
    expect(orgA['expansion.short_stay']).toBe(false);
    expect(orgA['expansion.student_housing']).toBe(true);
    expect(orgB['expansion.student_housing']).toBe(false);
    expect(visitor['expansion.student_housing']).toBe(false);
    expect(visitor['expansion.tendering']).toBe(true);
    expect(visitor['expansion.portfolio']).toBe(true);
  });
});

describe('requireFeature', () => {
  const identity = { featureFlags: { 'expansion.tendering': true } } as unknown as RequestIdentity;

  it('passes for enabled flags and throws feature_disabled otherwise', () => {
    expect(() => requireFeature(identity, 'expansion.tendering')).not.toThrow();
    expect(() => requireFeature(identity, expansionFlagKey('procurement'))).toThrow(
      expect.objectContaining({ code: 'feature_disabled', status: 404 }),
    );
  });
});

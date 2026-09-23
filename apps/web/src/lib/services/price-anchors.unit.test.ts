import { describe, expect, it } from 'vitest';
import { effectiveAnchor, parseAnchorSnapshot, type AnchorValues } from './price-anchors';

const base: AnchorValues = {
  name: 'Monitoring engagement',
  description: null,
  scopeMarkdown: null,
  priceBasis: 'from',
  amountKobo: '15000000',
  percentageBps: null,
  currency: 'NGN',
  minimumScope: 'One project',
  exclusions: 'Contractor works',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
};

describe('effectiveAnchor', () => {
  it('shows the live row when it is published and in force', () => {
    const r = effectiveAnchor(base, 'published', [], '2026-09-23');
    expect(r.values).toBe(base);
    expect(r.upcomingFrom).toBeNull();
  });

  it('never exposes values for in-review, draft or retired anchors', () => {
    for (const state of ['in_review', 'draft', 'retired'] as const) {
      const r = effectiveAnchor(base, state, [{ ...base }], '2026-09-23');
      expect(r.values).toBeNull();
      expect(r.state).toBe(state);
    }
  });

  it('keeps the earlier published revision until a future effective date arrives', () => {
    const upcoming = { ...base, amountKobo: '20000000', effectiveFrom: '2026-10-01' };
    const history = [base, upcoming];
    const before = effectiveAnchor(upcoming, 'published', history, '2026-09-23');
    expect(before.values?.amountKobo).toBe('15000000');
    expect(before.upcomingFrom).toBe('2026-10-01');
    const after = effectiveAnchor(upcoming, 'published', history, '2026-10-01');
    expect(after.values?.amountKobo).toBe('20000000');
    expect(after.upcomingFrom).toBeNull();
  });

  it('shows nothing (with the date) when a first publication is not yet in force', () => {
    const upcoming = { ...base, effectiveFrom: '2026-12-01' };
    const r = effectiveAnchor(upcoming, 'published', [upcoming], '2026-09-23');
    expect(r.values).toBeNull();
    expect(r.upcomingFrom).toBe('2026-12-01');
  });
});

describe('parseAnchorSnapshot', () => {
  it('accepts snapshots written by the pricing module and rejects anything else', () => {
    const ok = parseAnchorSnapshot({ kind: 'price_anchor', event: 'published', values: base });
    expect(ok?.state).toBe('published');
    expect(ok?.values.amountKobo).toBe('15000000');
    expect(parseAnchorSnapshot({ kind: 'market', event: 'published', values: base })).toBeNull();
    expect(
      parseAnchorSnapshot({ kind: 'price_anchor', event: 'deleted', values: base }),
    ).toBeNull();
    expect(parseAnchorSnapshot({ kind: 'price_anchor', event: 'submitted' })).toBeNull();
    expect(parseAnchorSnapshot(null)).toBeNull();
  });
});

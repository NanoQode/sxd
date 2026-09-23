import { describe, expect, it } from 'vitest';
import {
  documentStage,
  publicRequirements,
  requirementsForStage,
  type RequirementLike,
} from './document-requirements';

const svc = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

const reqs: RequirementLike[] = [
  { id: 'a', serviceId: svc, name: 'Title copy', description: null, stage: 'triage', required: true, sensitive: false, active: true, sortOrder: 10 },
  { id: 'b', serviceId: null, name: 'Photos', description: null, stage: null, required: false, sensitive: false, active: true, sortOrder: 5 },
  { id: 'c', serviceId: svc, name: 'Photo ID', description: null, stage: 'in_progress', required: false, sensitive: true, active: true, sortOrder: 20 },
  { id: 'd', serviceId: svc, name: 'Old form', description: null, stage: null, required: true, sensitive: false, active: false, sortOrder: 1 },
  { id: 'e', serviceId: other, name: 'Survey', description: null, stage: 'triage', required: true, sensitive: false, active: true, sortOrder: 1 },
];

describe('requirementsForStage', () => {
  it('splits by stage, drops inactive and other-service items and keeps sensitive ones for customers', () => {
    const r = requirementsForStage(reqs, { serviceId: svc, stage: 'triage', includeSensitive: true });
    expect(r.now.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r.later.map((x) => x.id)).toEqual(['c']);
  });

  it('excludes sensitive items when asked and returns nothing for a closed request', () => {
    const r = requirementsForStage(reqs, { serviceId: svc, stage: 'in_progress', includeSensitive: false });
    expect(r.now.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r.later).toEqual([]);
    expect(requirementsForStage(reqs, { serviceId: svc, stage: null, includeSensitive: true })).toEqual({ now: [], later: [] });
  });
});

describe('publicRequirements', () => {
  it('lists only active, non-sensitive requirements for the service or all services', () => {
    expect(publicRequirements(reqs, svc).map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('documentStage', () => {
  it('uses the status, the stage a paused request came from, and nothing once closed', () => {
    expect(documentStage('quoted')).toBe('quoted');
    expect(documentStage('completed')).toBeNull();
    expect(documentStage('cancelled')).toBeNull();
    expect(
      documentStage('paused', [
        { fromStatus: null, toStatus: 'inquiry', createdAt: '2026-01-01T00:00:00Z' },
        { fromStatus: 'inquiry', toStatus: 'triage', createdAt: '2026-01-02T00:00:00Z' },
        { fromStatus: 'triage', toStatus: 'paused', createdAt: '2026-01-03T00:00:00Z' },
      ]),
    ).toBe('triage');
    expect(documentStage('paused')).toBe('inquiry');
  });
});

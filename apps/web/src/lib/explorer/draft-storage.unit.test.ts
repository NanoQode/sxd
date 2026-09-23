import { describe, expect, it } from 'vitest';
import {
  DRAFT_STORAGE_KEY,
  clearDraft,
  loadDraft,
  loadLastScenarioId,
  memoryStorage,
  saveDraft,
  saveLastScenarioId,
} from './draft-storage';
import { DEFAULT_ASSUMPTIONS } from './scenario-form';

describe('draft storage', () => {
  it('round-trips a draft and validates it on load', () => {
    const storage = memoryStorage();
    const saved = saveDraft(
      {
        name: 'My plan',
        assumptions: DEFAULT_ASSUMPTIONS,
        priorities: { affordability: 0.5 },
        mode: 'assumption',
        scenarioId: null,
        compare: ['lagos', 'kano'],
      },
      storage,
      new Date('2026-09-23T10:00:00Z'),
    );
    expect(saved?.savedAt).toBe('2026-09-23T10:00:00.000Z');
    const loaded = loadDraft(storage);
    expect(loaded?.name).toBe('My plan');
    expect(loaded?.compare).toEqual(['lagos', 'kano']);
    expect(loaded?.assumptions.base.landCostNaira).toBeNull();
    clearDraft(storage);
    expect(loadDraft(storage)).toBeNull();
  });

  it('ignores corrupt or foreign data', () => {
    const storage = memoryStorage();
    storage.setItem(DRAFT_STORAGE_KEY, '{not json');
    expect(loadDraft(storage)).toBeNull();
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 2, name: 'x' }));
    expect(loadDraft(storage)).toBeNull();
  });

  it('survives an unavailable storage', () => {
    expect(loadDraft(null)).toBeNull();
    expect(saveDraft({ name: null, assumptions: DEFAULT_ASSUMPTIONS, priorities: {}, mode: 'evidence', scenarioId: null, compare: [] }, null)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDraft(throwing)).toBeNull();
    expect(loadLastScenarioId(throwing)).toBeNull();
    expect(() => saveLastScenarioId('x', throwing)).not.toThrow();
  });

  it('remembers the last saved scenario id', () => {
    const storage = memoryStorage();
    saveLastScenarioId('11111111-1111-4111-8111-111111111111', storage);
    expect(loadLastScenarioId(storage)).toBe('11111111-1111-4111-8111-111111111111');
    saveLastScenarioId(null, storage);
    expect(loadLastScenarioId(storage)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { scenarioUpdateSchema } from '@simplexd/contracts';
import { pickPresentKeys } from './patch';

describe('pickPresentKeys', () => {
  it('drops defaults Zod added for keys the client did not send', () => {
    const raw = { name: 'renamed', expectedUpdatedAt: '2026-09-23T00:00:00.000Z' };
    const parsed = scenarioUpdateSchema.parse(raw);
    // Zod 4 fills defaults on partial objects; without the guard these would reset the row.
    expect(parsed.mode).toBe('assumption');
    expect(parsed.marketIds).toEqual([]);
    const patch = pickPresentKeys(raw, parsed);
    expect(patch).toEqual({ name: 'renamed', expectedUpdatedAt: '2026-09-23T00:00:00.000Z' });
    expect('mode' in patch).toBe(false);
    expect('marketIds' in patch).toBe(false);
  });

  it('keeps keys the client sent explicitly, including explicit defaults', () => {
    const raw = { priorities: {}, marketIds: [] };
    const patch = pickPresentKeys(raw, scenarioUpdateSchema.parse(raw));
    expect(patch).toEqual({ priorities: {}, marketIds: [] });
    expect(pickPresentKeys(null, { a: 1 })).toEqual({});
    expect(pickPresentKeys([1], { a: 1 })).toEqual({});
  });
});

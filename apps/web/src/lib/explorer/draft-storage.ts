import { z } from 'zod';
import {
  prioritiesSchema,
  scenarioAssumptionsSchema,
  scenarioModeSchema,
  type Priorities,
  type ScenarioAssumptions,
} from '@simplexd/contracts';

/**
 * Anonymous continuity: the scenario draft (assumptions, name, priorities)
 * and the id of the last saved scenario are kept in localStorage so a visitor
 * who reloads or comes back later does not lose their inputs. Storage may be
 * unavailable (private mode, quota); every access is guarded.
 */

export const DRAFT_STORAGE_KEY = 'sx-explorer-draft-v1';
export const LAST_SCENARIO_KEY = 'sx-explorer-last-scenario-v1';

const draftSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  name: z.string().max(120).nullable(),
  assumptions: scenarioAssumptionsSchema,
  priorities: prioritiesSchema,
  mode: scenarioModeSchema,
  scenarioId: z.string().nullable(),
  compare: z.array(z.string()).max(10),
});

export type ExplorerDraft = z.infer<typeof draftSchema>;

export interface DraftInput {
  name: string | null;
  assumptions: ScenarioAssumptions;
  priorities: Priorities;
  mode: 'evidence' | 'assumption';
  scenarioId: string | null;
  compare: string[];
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(storage: StorageLike | null = defaultStorage()): ExplorerDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveDraft(
  input: DraftInput,
  storage: StorageLike | null = defaultStorage(),
  now: Date = new Date(),
): ExplorerDraft | null {
  if (!storage) return null;
  const draft: ExplorerDraft = { version: 1, savedAt: now.toISOString(), ...input };
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return draft;
  } catch {
    return null;
  }
}

export function clearDraft(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadLastScenarioId(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    const value = storage?.getItem(LAST_SCENARIO_KEY) ?? null;
    return value && value.length <= 64 ? value : null;
  } catch {
    return null;
  }
}

export function saveLastScenarioId(
  id: string | null,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    if (!storage) return;
    if (id === null) storage.removeItem(LAST_SCENARIO_KEY);
    else storage.setItem(LAST_SCENARIO_KEY, id);
  } catch {
    /* ignore */
  }
}

/** In-memory storage for tests and for browsers without localStorage. */
export function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getSessionKey, purgeOtherSessionKeys, webCryptoSupported } from './crypto';
import {
  createIndexedDbStorage,
  createMemoryStorage,
  indexedDbAvailable,
  type DraftStorage,
} from './storage';
import { createDraftStore, type DraftStore } from './store';
import type { Draft, LockedDraft } from './types';

/**
 * One store per signed-in user per page. The storage adapter is a module
 * singleton so every hook instance sees the same drafts; the store itself is
 * per user so a different sign-in gets a different namespace and key.
 */

let sharedStorage: DraftStorage | null = null;
function storage(): DraftStorage {
  if (!sharedStorage)
    sharedStorage = indexedDbAvailable() ? createIndexedDbStorage() : createMemoryStorage();
  return sharedStorage;
}

const CHANGE_EVENT = 'sxd-partner-drafts-changed';

export function notifyDraftsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export interface DraftStoreState {
  store: DraftStore | null;
  ready: boolean;
  /** Why sensitive fields cannot be sealed (null when everything works). */
  sealingProblem: string | null;
  persistent: boolean;
}

export function useDraftStore(userId: string): DraftStoreState {
  const [state, setState] = useState<DraftStoreState>({
    store: null,
    ready: false,
    sealingProblem: null,
    persistent: true,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = storage();
      let key: CryptoKey | null = null;
      let problem: string | null = null;
      if (!webCryptoSupported()) {
        problem =
          'This browser has no WebCrypto, so drafts cannot be encrypted and will not be stored.';
      } else {
        try {
          purgeOtherSessionKeys(userId);
          key = await getSessionKey(userId);
          if (!key)
            problem =
              'Session storage is blocked, so there is nowhere to keep the encryption key. Drafts will not be stored.';
        } catch (err) {
          problem = err instanceof Error ? err.message : 'could not prepare the encryption key';
        }
      }
      if (cancelled) return;
      setState({
        store: createDraftStore({ userId, key, storage: s }),
        ready: true,
        sealingProblem: problem,
        persistent: s.persistent,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return state;
}

/** Live list of the user's drafts (re-reads on the change event and on focus). */
export function useDrafts(
  userId: string,
): { drafts: Array<Draft | LockedDraft>; loading: boolean; refresh: () => void } & DraftStoreState {
  const storeState = useDraftStore(userId);
  const [drafts, setDrafts] = useState<Array<Draft | LockedDraft>>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    if (!storeState.store) return;
    storeState.store
      .list()
      .then((list) => setDrafts(list))
      .catch(() => setDrafts([]))
      .finally(() => setLoading(false));
  }, [storeState.store]);
  useEffect(() => {
    refresh();
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return useMemo(
    () => ({ ...storeState, drafts, loading, refresh }),
    [storeState, drafts, loading, refresh],
  );
}

/** Online/offline as reported by the browser (a hint, not a guarantee). */
function subscribeOnline(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

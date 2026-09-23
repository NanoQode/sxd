'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Saved table views: a named snapshot of the current URL query (filters,
 * sort, page size). Views live in localStorage per table key and per
 * browser; the URL remains the source of truth so a view is shareable by
 * copying the link.
 */

export interface SavedView {
  name: string;
  query: string;
  savedAt: string;
}

const STORAGE_PREFIX = 'sx.admin.views.';

const EMPTY: SavedView[] = [];
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; views: SavedView[] }>();
/** In-memory fallback when localStorage is unavailable (private mode): views last for the session. */
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function parseViews(raw: string | null): SavedView[] {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as SavedView).name === 'string' &&
        typeof (v as SavedView).query === 'string',
    );
  } catch {
    return EMPTY;
  }
}

/** Stable snapshot per key (same array while the stored text is unchanged). */
function read(key: string): SavedView[] {
  const raw = readRaw(key);
  const cached = snapshots.get(key);
  if (cached && cached.raw === raw) return cached.views;
  const views = parseViews(raw);
  snapshots.set(key, { raw, views });
  return views;
}

function write(key: string, views: SavedView[]): void {
  const text = JSON.stringify(views);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, text);
  } catch {
    memory.set(key, text);
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** Strips pagination so a saved view always opens on page 1. */
export function normalizeQuery(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('page');
  params.delete('cursor');
  params.sort();
  return params.toString();
}

export function useSavedViews(tableKey: string) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const views = useSyncExternalStore(
    subscribe,
    () => read(tableKey),
    () => EMPTY,
  );

  const currentQuery = normalizeQuery(searchParams.toString());
  const activeName = views.find((v) => v.query === currentQuery)?.name ?? null;

  const save = useCallback(
    (name: string) => {
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) return;
      const next = [
        ...read(tableKey).filter((v) => v.name !== trimmed),
        { name: trimmed, query: currentQuery, savedAt: new Date().toISOString() },
      ];
      write(tableKey, next);
    },
    [tableKey, currentQuery],
  );

  const remove = useCallback(
    (name: string) => {
      const next = read(tableKey).filter((v) => v.name !== name);
      write(tableKey, next);
    },
    [tableKey],
  );

  const apply = useCallback(
    (view: SavedView) => {
      router.push(view.query ? `${pathname}?${view.query}` : pathname);
    },
    [router, pathname],
  );

  const clear = useCallback(() => router.push(pathname), [router, pathname]);

  return { views, activeName, currentQuery, save, remove, apply, clear };
}

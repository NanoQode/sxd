'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

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

function read(key: string): SavedView[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === 'object' && v !== null && typeof (v as SavedView).name === 'string',
    );
  } catch {
    return [];
  }
}

function write(key: string, views: SavedView[]): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(views));
  } catch {
    // Storage may be unavailable (private mode); views are then session-only.
  }
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
  const [views, setViews] = useState<SavedView[]>([]);
  useEffect(() => {
    setViews(read(tableKey));
  }, [tableKey]);

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
      setViews(next);
    },
    [tableKey, currentQuery],
  );

  const remove = useCallback(
    (name: string) => {
      const next = read(tableKey).filter((v) => v.name !== name);
      write(tableKey, next);
      setViews(next);
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

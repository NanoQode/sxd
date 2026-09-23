'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** True when the media query matches; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
    () => false,
  );
}

export const DESKTOP_QUERY = '(min-width: 1024px)';

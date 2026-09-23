'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MOTION_STORAGE_KEY, THEME_STORAGE_KEY } from './init-script';

export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'reduce' | 'full';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  motion: MotionPreference;
  setMotion: (motion: MotionPreference) => void;
  reducedMotion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Preference stored on the authenticated user's profile, if any. */
  serverTheme?: ThemePreference | null;
  serverMotion?: MotionPreference | null;
  /** Persists the preference to the profile for signed-in users. */
  onPersist?: (prefs: { theme: ThemePreference; motion: MotionPreference }) => void | Promise<void>;
}

function readStored(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); the DOM attribute still applies */
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function systemReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ThemeProvider({
  children,
  serverTheme,
  serverMotion,
  onPersist,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    if (serverTheme) return serverTheme;
    const stored = readStored(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });
  const [motion, setMotionState] = useState<MotionPreference>(() => {
    if (serverMotion) return serverMotion;
    const stored = readStored(MOTION_STORAGE_KEY);
    return stored === 'reduce' || stored === 'full' ? stored : 'system';
  });
  const [systemDark, setSystemDark] = useState<boolean>(() => systemTheme() === 'dark');
  const [systemReduce, setSystemReduce] = useState<boolean>(() => systemReducedMotion());

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onDark = () => setSystemDark(dark.matches);
    const onReduce = () => setSystemReduce(reduce.matches);
    dark.addEventListener('change', onDark);
    reduce.addEventListener('change', onReduce);
    return () => {
      dark.removeEventListener('change', onDark);
      reduce.removeEventListener('change', onReduce);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    if (motion === 'system') root.removeAttribute('data-motion');
    else root.setAttribute('data-motion', motion);
  }, [theme, motion]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(next);
      writeStored(THEME_STORAGE_KEY, next === 'system' ? null : next);
      void onPersist?.({ theme: next, motion });
    },
    [motion, onPersist],
  );

  const setMotion = useCallback(
    (next: MotionPreference) => {
      setMotionState(next);
      writeStored(MOTION_STORAGE_KEY, next === 'system' ? null : next);
      void onPersist?.({ theme, motion: next });
    },
    [theme, onPersist],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme,
      setTheme,
      motion,
      setMotion,
      reducedMotion: motion === 'reduce' || (motion === 'system' && systemReduce),
    }),
    [theme, systemDark, setTheme, motion, setMotion, systemReduce],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

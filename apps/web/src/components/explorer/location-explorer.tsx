'use client';

import { Suspense } from 'react';
import type { AccountAccess, ExplorerVariant } from '@/lib/explorer';
import { ExplorerProvider } from './explorer-context';
import { ExplorerShell } from './explorer-shell';
import { ExplorerSkeleton } from './explorer-skeleton';

export interface LocationExplorerProps {
  variant?: ExplorerVariant;
  /**
   * Resolved by the server page from the request identity: whether the visitor
   * is signed in and whether `core.anonymous_scenarios` allows anonymous saves.
   * Omitted means fully gated (the safe default).
   */
  access?: AccountAccess;
}

/**
 * The URL is the explorer's state (nuqs reads the search params), so the tree
 * sits under a Suspense boundary; the fallback reserves the same height as
 * the explorer so nothing shifts when it resolves.
 */
export function LocationExplorer({ variant = 'homepage', access }: LocationExplorerProps) {
  return (
    <Suspense fallback={<ExplorerSkeleton variant={variant} />}>
      <ExplorerProvider variant={variant} access={access}>
        <ExplorerShell />
      </ExplorerProvider>
    </Suspense>
  );
}

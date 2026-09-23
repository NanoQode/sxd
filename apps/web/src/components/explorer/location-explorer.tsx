'use client';

import { Suspense } from 'react';
import type { ExplorerVariant } from '@/lib/explorer';
import { ExplorerProvider } from './explorer-context';
import { ExplorerShell } from './explorer-shell';
import { ExplorerSkeleton } from './explorer-skeleton';

export interface LocationExplorerProps {
  variant?: ExplorerVariant;
}

/**
 * The URL is the explorer's state (nuqs reads the search params), so the tree
 * sits under a Suspense boundary; the fallback reserves the same height as
 * the explorer so nothing shifts when it resolves.
 */
export function LocationExplorer({ variant = 'homepage' }: LocationExplorerProps) {
  return (
    <Suspense fallback={<ExplorerSkeleton variant={variant} />}>
      <ExplorerProvider variant={variant}>
        <ExplorerShell />
      </ExplorerProvider>
    </Suspense>
  );
}

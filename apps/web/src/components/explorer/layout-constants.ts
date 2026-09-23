import type { ExplorerVariant } from '@/lib/explorer';

/** Fixed map heights so the static preview, the map and the fallback never shift layout. */
export const MAP_HEIGHT_CLASS: Record<ExplorerVariant, string> = {
  homepage: 'h-[360px] sm:h-[420px]',
  full: 'h-[420px] lg:h-[560px]',
};

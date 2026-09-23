import type { ReactNode } from 'react';
import { requireStaffPage } from '@/lib/auth/session';
import { MarketDataNav } from './_components/market-data-nav';

export const dynamic = 'force-dynamic';

/** Market Data section: readable with market_data.read_drafts; each action checks its own permission. */
export default async function MarketDataLayout({ children }: { children: ReactNode }) {
  await requireStaffPage('market_data.read_drafts');
  return (
    <div className="space-y-6">
      <MarketDataNav />
      {children}
    </div>
  );
}

import type { Metadata } from 'next';
import { BidWorkspace } from '@/components/partner/tenders/bid-workspace';

export const metadata: Metadata = { title: 'Bid workspace' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BidWorkspace tenderId={id} />;
}

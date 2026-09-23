import type { Metadata } from 'next';
import { TendersList } from '@/components/partner/tenders/tenders-list';

export const metadata: Metadata = { title: 'Tenders & bids' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <TendersList />;
}

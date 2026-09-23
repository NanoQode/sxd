import type { Metadata } from 'next';
import { TenderDetailView } from '@/components/partner/tenders/tender-detail';

export const metadata: Metadata = { title: 'Tender' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TenderDetailView tenderId={id} />;
}

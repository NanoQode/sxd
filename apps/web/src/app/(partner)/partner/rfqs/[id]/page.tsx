import type { Metadata } from 'next';
import { RfqDetailView } from '@/components/partner/rfqs/rfq-detail';

export const metadata: Metadata = { title: 'RFQ' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RfqDetailView rfqId={id} />;
}

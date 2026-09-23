import type { Metadata } from 'next';
import { PartnerHome } from '@/components/partner/home';

export const metadata: Metadata = { title: 'Partner workspace' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <PartnerHome />;
}

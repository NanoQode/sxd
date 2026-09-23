import type { Metadata } from 'next';
import { PartnerInvoicesPage } from '@/components/partner/invoices/invoices-page';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <PartnerInvoicesPage />;
}

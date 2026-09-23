import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RfqsPage } from '@/components/partner/rfqs/rfqs-page';
import { LoadingBlock } from '@/components/partner/common';

export const metadata: Metadata = { title: 'RFQs & orders' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <RfqsPage />
    </Suspense>
  );
}

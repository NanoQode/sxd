import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VisitsList } from '@/components/partner/visits/visits-list';
import { LoadingBlock } from '@/components/partner/common';

export const metadata: Metadata = { title: 'Visits' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <VisitsList />
    </Suspense>
  );
}

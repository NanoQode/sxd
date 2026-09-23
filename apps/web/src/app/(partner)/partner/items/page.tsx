import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AssignedItems } from '@/components/partner/items/assigned-items';
import { LoadingBlock } from '@/components/partner/common';

export const metadata: Metadata = { title: 'Assigned items' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <AssignedItems />
    </Suspense>
  );
}

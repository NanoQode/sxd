import type { Metadata } from 'next';
import { Suspense } from 'react';
import { EvidencePage } from '@/components/partner/evidence/evidence-page';
import { LoadingBlock } from '@/components/partner/common';

export const metadata: Metadata = { title: 'Evidence' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <EvidencePage />
    </Suspense>
  );
}

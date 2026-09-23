import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReportsList } from '@/components/partner/reports/reports-list';
import { LoadingBlock } from '@/components/partner/common';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <ReportsList />
    </Suspense>
  );
}

import type { Metadata } from 'next';
import { ReportEditor } from '@/components/partner/reports/report-editor';

export const metadata: Metadata = { title: 'Report' };
export const dynamic = 'force-dynamic';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const projectId = typeof sp.projectId === 'string' ? sp.projectId : null;
  return <ReportEditor target={id} projectId={projectId} />;
}

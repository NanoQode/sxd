import type { Metadata } from 'next';
import { FieldCapture } from '@/components/partner/visits/field-capture';

export const metadata: Metadata = { title: 'Field capture' };
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
  return <FieldCapture target={id} projectId={projectId} />;
}

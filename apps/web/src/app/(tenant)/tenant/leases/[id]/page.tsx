import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Alias: lease notices store `/tenant/leases/{id}` as their in-app link
 * (server/rentals/leases.ts) while other notifications use
 * `/tenant/lease/{id}`. Both land on the same lease page.
 */
export default async function TenantLeaseAlias({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/tenant/lease/${encodeURIComponent(id)}`);
}

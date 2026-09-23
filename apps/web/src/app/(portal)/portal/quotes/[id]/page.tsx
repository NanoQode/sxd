import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { uuidSchema } from '@simplexd/contracts';
import { PageHeader } from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { loadQuote } from '@/lib/portal/server/finance';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { QuoteCard } from '@/components/portal/quote-panel';

export const metadata: Metadata = { title: 'Quote' };
export const dynamic = 'force-dynamic';

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/quotes/${id}`);
  const quote = await loadQuote(identity, id);
  if (!quote) notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(identity, quote.organizationId);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/portal/requests/${quote.serviceRequestId}?tab=quotes`} className="underline">
            Back to the request
          </Link>
        }
        title={`Quote v${quote.currentVersion}`}
        description="Every version is kept; only the current issued version can be accepted. Your acceptance records your typed signature and the terms version."
      />
      <QuoteCard
        quote={quote}
        zone={zone}
        canAccept={caps.acceptQuotes}
        cannotAcceptReason={caps.acceptQuotes ? undefined : capabilityNote(caps, 'Accepting a quote')}
        requestHref={`/portal/requests/${quote.serviceRequestId}`}
      />
    </div>
  );
}

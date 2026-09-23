import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyPaymentAttempt } from '@simplexd/finance';
import { getIdentity } from '@/lib/auth/session';
import { parseQuery, route } from '@/lib/api/respond';
import { financeActorFrom, getFinanceRuntime } from '@/server/finance/runtime';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  reference: z.string().regex(/^[A-Za-z0-9.=-]{1,100}$/),
  trxref: z.string().max(100).optional(),
});

/**
 * GET /api/v1/payment-attempts/callback?reference= — the hosted checkout
 * returns the customer here. Visiting is not settlement: the server verifies
 * with the provider and redirects to the invoice with the outcome.
 */
export const GET = route(async (req, { correlationId }) => {
  const { reference } = parseQuery(req, querySchema);
  const identity = await getIdentity();
  const url = new URL(req.url);
  if (!identity.session) {
    const next = `${url.pathname}?reference=${encodeURIComponent(reference)}`;
    return NextResponse.redirect(
      new URL(`/sign-in?next=${encodeURIComponent(next)}`, url.origin),
      303,
    );
  }
  const rt = getFinanceRuntime();
  const fa = financeActorFrom(identity, req, correlationId);
  const result = await verifyPaymentAttempt(rt, fa, { reference }, { source: 'callback' });
  // Members of the issuing organisation return to the portal invoice; a payer
  // who is not a member (a tenant paying rent invoiced by the owner's
  // organisation) returns to their tenant balances. Both pages show the
  // stored, provider-verified status, never the query string.
  const member = identity.actor.memberships.some(
    (m) => m.organizationId === result.attempt.organizationId,
  );
  const target =
    member || identity.actor.staffRoles.length > 0
      ? new URL(`/portal/invoices/${result.attempt.invoiceId}`, rt.appUrl)
      : new URL('/tenant/balances', rt.appUrl);
  target.searchParams.set('payment', result.decision);
  target.searchParams.set('attempt', result.attempt.id);
  return NextResponse.redirect(target, 303);
});

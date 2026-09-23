'use client';

import { BadgeCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { useState } from 'react';
import { Badge, formatDateLabel } from '@simplexd/ui';
import type { PartnerVerification } from '@/lib/partner/context';

/**
 * States exactly what was checked and when, taken from the partner profile.
 * "Verified" without a scope is shown as such rather than implying more.
 */
export function VerificationBadge({
  verification,
  zone,
}: {
  verification: PartnerVerification | null;
  zone: string;
}) {
  const [now] = useState(() => Date.now());
  if (!verification) {
    return (
      <Badge
        tone="neutral"
        title="No partner profile: verification does not apply to staff accounts."
      >
        <ShieldQuestion aria-hidden="true" className="h-3 w-3" />
        Staff account
      </Badge>
    );
  }
  const expired = verification.expiresAt ? new Date(verification.expiresAt).getTime() < now : false;
  const status = expired ? 'expired' : verification.status;
  const tone =
    status === 'verified'
      ? 'success'
      : status === 'expired' || status === 'rejected'
        ? 'danger'
        : 'warning';
  const Icon =
    status === 'verified'
      ? BadgeCheck
      : status === 'expired' || status === 'rejected'
        ? ShieldX
        : ShieldQuestion;
  const checked = verification.verifiedAt
    ? `checked ${formatDateLabel(verification.verifiedAt, zone)}`
    : 'no check recorded';
  const scope = (verification.scope ?? 'scope of the check not recorded').replace(/[.\s]+$/, '');
  const expiry = verification.expiresAt
    ? `; valid until ${formatDateLabel(verification.expiresAt, zone)}`
    : '';
  const label =
    status === 'verified'
      ? `Verified`
      : status === 'pending'
        ? 'Verification pending'
        : status === 'expired'
          ? 'Verification expired'
          : status === 'rejected'
            ? 'Verification rejected'
            : 'Unverified';
  return (
    <details className="relative">
      <summary className="sx-touch flex cursor-pointer list-none items-center rounded-md px-1 [&::-webkit-details-marker]:hidden">
        <Badge tone={tone}>
          <Icon aria-hidden="true" className="h-3 w-3" />
          {label}
        </Badge>
        <span className="sr-only">Show what was verified</span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-32px)] rounded-md border border-border bg-bg-elevated p-3 text-xs shadow-lg">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-fg-muted">
          What was checked: {scope}. When: {checked}
          {expiry}.
        </p>
        {verification.credentials.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {verification.credentials.map((c, i) => (
              <li key={`${c.title}-${i}`}>
                <span className="font-medium">{c.title}</span>
                {c.issuer ? ` · ${c.issuer}` : ''}
                {c.verifiedAt
                  ? ` · verified ${formatDateLabel(c.verifiedAt, zone)}`
                  : ' · not verified'}
                {c.expiresAt ? ` · expires ${formatDateLabel(c.expiresAt, zone)}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-fg-muted">
            No individual credentials are recorded on your profile.
          </p>
        )}
      </div>
    </details>
  );
}

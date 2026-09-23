'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface PartnerVerification {
  status: string;
  scope: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  credentials: Array<{ title: string; issuer?: string; verifiedAt?: string; expiresAt?: string }>;
}

export interface PartnerIdentity {
  userId: string;
  name: string;
  email: string;
  timeZone: string;
  /** Has a partner_profiles row (contractor, vendor, surveyor, ...). */
  isPartner: boolean;
  partnerType: string | null;
  displayName: string | null;
  /** Staff member with the inspector role. */
  isStaffInspector: boolean;
  isStaff: boolean;
  verification: PartnerVerification | null;
  /** Feature flags relevant to the workspace (mirrors the API's gating). */
  flags: { tendering: boolean; procurement: boolean };
}

const PartnerContext = createContext<PartnerIdentity | null>(null);

export function PartnerProvider({
  value,
  children,
}: {
  value: PartnerIdentity;
  children: ReactNode;
}) {
  return <PartnerContext.Provider value={value}>{children}</PartnerContext.Provider>;
}

export function usePartner(): PartnerIdentity {
  const ctx = useContext(PartnerContext);
  if (!ctx) throw new Error('usePartner must be used inside the partner workspace');
  return ctx;
}

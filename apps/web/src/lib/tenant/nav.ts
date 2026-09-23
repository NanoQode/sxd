import {
  Bell,
  CalendarDays,
  FileText,
  Home,
  ReceiptText,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Tenant navigation: only the records a tenant may see (their lease,
 * balances, receipts, maintenance, appointments and notices). No portfolio,
 * statements or owner modules are ever linked from here.
 */
export interface TenantNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Paths that also mark this item current (e.g. the notification alias for leases). */
  alsoMatches?: string[];
  count?: number;
}

export function tenantNav(currentLeaseId: string | null, unreadNotices: number): TenantNavItem[] {
  return [
    { href: '/tenant', label: 'Home', icon: Home, exact: true },
    ...(currentLeaseId
      ? [
          {
            href: `/tenant/lease/${currentLeaseId}`,
            label: 'My lease',
            icon: FileText,
            alsoMatches: ['/tenant/lease/', '/tenant/leases/'],
          },
        ]
      : []),
    { href: '/tenant/balances', label: 'Balances', icon: Wallet },
    { href: '/tenant/receipts', label: 'Receipts', icon: ReceiptText },
    { href: '/tenant/tickets', label: 'Maintenance', icon: Wrench },
    { href: '/tenant/appointments', label: 'Appointments', icon: CalendarDays },
    { href: '/tenant/notices', label: 'Notices', icon: Bell, count: unreadNotices },
  ];
}

export function isCurrent(item: TenantNavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return item.alsoMatches?.some((p) => pathname.startsWith(p)) ?? false;
}


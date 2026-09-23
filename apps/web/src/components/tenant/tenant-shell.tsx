'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarDays,
  FileText,
  Home,
  LogOut,
  ReceiptText,
  ShieldAlert,
  Wallet,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  ReduceMotionToggle,
  ThemeToggle,
  cn,
  formatDateTimeLabel,
} from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

export interface TenantNavItem {
  href: string;
  label: string;
  icon: typeof Home;
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

/**
 * Tenant shell: restricted navigation (lease, balances, receipts,
 * maintenance, appointments, notices only), theme and motion controls, and
 * sign-out that clears cached private data.
 */
export function TenantShell({
  children,
  user,
  currentLeaseId,
  unreadNotices,
  hasPortal,
  impersonation,
}: {
  children: ReactNode;
  user: { name: string; email: string };
  currentLeaseId: string | null;
  unreadNotices: number;
  hasPortal: boolean;
  impersonation: { adminUserId: string; expiresAt: string } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const nav = tenantNav(currentLeaseId, unreadNotices);

  async function signOut() {
    setSigningOut(true);
    await authClient.signOut().catch(() => undefined);
    queryClient.clear();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#tenant-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2 focus:shadow-md"
      >
        Skip to content
      </a>
      {impersonation ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b-2 border-danger bg-danger-soft px-4 py-2 text-sm"
        >
          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-danger" />
          <strong>Support impersonation active.</strong>
          <span>
            Administrator <code className="font-mono">{impersonation.adminUserId}</code> is viewing
            this account as {user.email}. Expires {formatDateTimeLabel(impersonation.expiresAt)}.
          </span>
        </div>
      ) : null}
      <header className="border-b border-border bg-bg-elevated">
        <div className="sx-container flex h-16 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/tenant" className="font-display text-lg font-semibold">
              SimplexD
            </Link>
            <Badge tone="gold">Tenant</Badge>
          </div>
          <div className="flex items-center gap-2">
            {hasPortal ? (
              <Link href="/portal" className="hidden text-sm text-primary underline sm:inline">
                Customer portal
              </Link>
            ) : null}
            <ThemeToggle compact />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
              loading={signingOut}
              loadingLabel="Signing out"
              aria-label={`Sign out ${user.email}`}
            >
              <LogOut aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <div className="sx-container flex flex-1 flex-col gap-6 py-6 md:flex-row">
        <nav aria-label="Tenant" className="md:w-56 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible">
            {nav.map((item) => {
              const current = isCurrent(item, pathname);
              const Icon = item.icon;
              return (
                <li key={item.href} className="shrink-0">
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'sx-transition sx-touch flex items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap',
                      current
                        ? 'bg-primary-soft font-medium text-primary'
                        : 'text-fg-muted hover:bg-bg-sunken hover:text-fg',
                    )}
                  >
                    <Icon aria-hidden="true" className="h-4 w-4" />
                    {item.label}
                    {item.count ? (
                      <Badge tone="primary" className="ml-auto">
                        {item.count} new
                      </Badge>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 hidden border-t border-border pt-4 md:block">
            <ReduceMotionToggle />
            <p className="mt-3 truncate text-xs text-fg-subtle" title={user.email}>
              {user.name}
              <br />
              {user.email}
            </p>
          </div>
        </nav>
        <main id="tenant-main" tabIndex={-1} className="min-w-0 flex-1 space-y-6 focus:outline-none">
          {children}
          <div className="border-t border-border pt-4 md:hidden">
            <ReduceMotionToggle />
          </div>
        </main>
      </div>
    </div>
  );
}

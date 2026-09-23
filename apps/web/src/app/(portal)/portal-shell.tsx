'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  ClipboardList,
  FolderOpen,
  HardHat,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  Receipt,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { OrganizationMembershipDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  NativeSelect,
  ReduceMotionToggle,
  ThemeToggle,
  cn,
  formatDateTimeLabel,
} from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';

const NAV: Array<{ href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }> = [
  { href: '/portal', label: 'Home', icon: LayoutDashboard, exact: true },
  { href: '/portal/properties', label: 'Properties', icon: Building2 },
  { href: '/portal/projects', label: 'Projects', icon: HardHat },
  { href: '/portal/requests', label: 'Requests', icon: ClipboardList },
  { href: '/portal/documents', label: 'Documents', icon: FolderOpen },
  { href: '/portal/invoices', label: 'Invoices', icon: Receipt },
  { href: '/portal/appointments', label: 'Appointments', icon: CalendarDays },
  { href: '/portal/messages', label: 'Messages', icon: MessageSquare },
  { href: '/portal/scenarios', label: 'Scenarios', icon: MapIcon },
  { href: '/portal/settings', label: 'Settings', icon: Settings },
];

export function PortalShell({
  children,
  user,
  memberships,
  activeOrganizationId,
  isStaff,
  impersonation,
}: {
  children: ReactNode;
  user: { name: string; email: string };
  memberships: OrganizationMembershipDto[];
  activeOrganizationId: string | null;
  isStaff: boolean;
  impersonation: { adminUserId: string; expiresAt: string } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const active = memberships.find((m) => m.organizationId === activeOrganizationId) ?? null;

  async function switchOrganization(organizationId: string) {
    if (organizationId === activeOrganizationId) return;
    setSwitching(true);
    setSwitchError(null);
    const res = await authClient.organization.setActive({ organizationId });
    if (res.error) {
      setSwitchError(res.error.message ?? 'Could not switch organisation.');
      setSwitching(false);
      return;
    }
    // Private data from the previous organisation must not survive the switch.
    queryClient.clear();
    router.refresh();
    setSwitching(false);
  }

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {impersonation ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b-2 border-danger bg-danger-soft px-4 py-2 text-sm"
        >
          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-danger" />
          <strong>Support impersonation active.</strong>
          <span>
            Administrator <code className="font-mono">{impersonation.adminUserId}</code> is viewing
            this account as {user.email}. Financial approvals, payments and settings changes are
            blocked. Expires {formatDateTimeLabel(impersonation.expiresAt)}.
          </span>
        </div>
      ) : null}
      <header className="border-b border-border bg-bg-elevated">
        <div className="sx-container flex h-16 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/portal" className="font-display text-lg font-semibold">
              SimplexD
            </Link>
            {memberships.length > 0 ? (
              <label className="flex min-w-0 items-center gap-2 text-sm">
                <span className="sr-only sm:not-sr-only sm:text-fg-muted">Organisation</span>
                <NativeSelect
                  aria-label="Active organisation"
                  className="max-w-[220px]"
                  value={activeOrganizationId ?? ''}
                  disabled={switching}
                  onChange={(e) => void switchOrganization(e.target.value)}
                >
                  {memberships.map((m) => (
                    <option key={m.organizationId} value={m.organizationId}>
                      {m.name}
                      {m.role !== 'owner' ? ` (${m.role})` : ''}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isStaff ? (
              <Link href="/admin" className="hidden text-sm text-primary underline sm:inline">
                Admin
              </Link>
            ) : null}
            <ThemeToggle compact />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
              aria-label={`Sign out ${user.email}`}
            >
              <LogOut aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
        {switchError ? (
          <div className="sx-container pb-2">
            <Alert tone="danger" title="Could not switch organisation">
              {switchError}
            </Alert>
          </div>
        ) : null}
      </header>
      <div className="sx-container flex flex-1 flex-col gap-6 py-6 md:flex-row">
        <nav aria-label="Portal" className="md:w-56 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible">
            {NAV.map((item) => {
              const current = item.exact ? pathname === item.href : pathname.startsWith(item.href);
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
        <main className="min-w-0 flex-1 space-y-6">
          {memberships.length === 0 ? (
            <Alert tone="warning" title="No organisation yet">
              Your account is not part of a customer organisation, so there is nothing to show here.{' '}
              <Link href="/onboarding" className="font-medium text-primary underline">
                Set up your organisation
              </Link>{' '}
              to request services, or accept an invitation you received by email.
            </Alert>
          ) : !active ? (
            <Alert tone="warning" title="Select an organisation">
              Choose the organisation you want to work in from the switcher above.
            </Alert>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

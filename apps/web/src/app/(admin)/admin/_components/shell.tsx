'use client';

import {
  Activity,
  BarChart3,
  Briefcase,
  Building2,
  CalendarDays,
  ClipboardList,
  FileText,
  Gavel,
  Home,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  MessageSquare,
  Newspaper,
  Plug,
  Search,
  Settings,
  ShoppingCart,
  UserCheck,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Dialog, DialogContent, ThemeToggle, cn } from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';
import type { NavIcon, NavItem, SubNavItem } from '../_lib/navigation';
import { CommandPalette } from './command-palette';

const icons: Record<NavIcon, typeof Home> = {
  overview: LayoutDashboard,
  leads: Users,
  customers: Building2,
  properties: Home,
  projects: Briefcase,
  requests: ClipboardList,
  assignments: UserCheck,
  reports: FileText,
  tenders: Gavel,
  procurement: ShoppingCart,
  rentals: Wrench,
  finance: Wallet,
  appointments: CalendarDays,
  messages: MessageSquare,
  'market-data': Map,
  content: Newspaper,
  partners: BarChart3,
  integrations: Plug,
  settings: Settings,
  audit: Activity,
};

function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const Icon = icons[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'sx-transition sx-touch flex items-center gap-3 rounded-md px-3 text-sm',
                  active
                    ? 'bg-primary-soft font-medium text-primary'
                    : 'text-fg-muted hover:bg-bg-sunken hover:text-fg',
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.plannedWave ? (
                  <span className="ml-auto rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                    Wave {item.plannedWave}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AdminShell({
  nav,
  subNav,
  user,
  roles,
  mfaVerified,
  canSearchMarkets,
  children,
}: {
  nav: NavItem[];
  subNav: SubNavItem[];
  user: { name: string; email: string };
  roles: string[];
  mfaVerified: boolean;
  canSearchMarkets: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }, [router]);

  return (
    <div className="flex min-h-dvh bg-bg text-fg">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-bg-elevated lg:flex">
        <div className="flex h-16 items-center px-4">
          <Link href="/admin" className="font-display text-lg font-semibold">
            SimplexD <span className="text-fg-muted">Admin</span>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <NavList items={nav} />
        </div>
        <div className="border-t border-border p-3 text-xs text-fg-muted">
          <p className="truncate font-medium text-fg">{user.name}</p>
          <p className="truncate">{user.email}</p>
          <p className="mt-1 truncate">{roles.map((r) => r.replace(/_/g, ' ')).join(', ')}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-2 border-b border-border bg-bg-elevated/95 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu aria-hidden="true" className="h-5 w-5" />
          </Button>
          <Link href="/admin" className="font-display text-base font-semibold lg:hidden">
            Admin
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="sx-transition sx-touch ml-auto flex w-full max-w-sm items-center gap-2 rounded-md border border-border-strong bg-bg px-3 text-sm text-fg-muted hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            aria-label="Search sections and markets"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search aria-hidden="true" className="h-4 w-4" />
            <span className="flex-1 truncate text-left">Search sections and markets</span>
            <kbd className="hidden rounded border border-border px-1 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <ThemeToggle compact />
          <Link
            href="/admin/security/mfa"
            className="sx-touch hidden items-center gap-1 rounded-md px-2 text-sm text-fg-muted hover:text-fg md:flex"
          >
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            <span>{mfaVerified ? 'MFA on' : 'MFA off'}</span>
          </Link>
          <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
            <LogOut aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>
        {!mfaVerified && !pathname.startsWith('/admin/security/mfa') ? (
          <div className="border-b border-border bg-warning-soft px-4 py-2 sm:px-6">
            <Alert tone="warning" title="Authenticator not enrolled" className="border-0 bg-transparent p-0">
              Sensitive actions (publishing market data, changing policies, managing roles, settings
              and integrations) require a verified authenticator.{' '}
              <Link href="/admin/security/mfa" className="font-medium text-primary underline">
                Enrol an authenticator
              </Link>
              .
            </Alert>
          </div>
        ) : null}
        <main id="admin-main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent title="Navigate" size="sheet">
          <NavList items={nav} onNavigate={() => setMenuOpen(false)} />
          <div className="mt-4 border-t border-border pt-3 text-xs text-fg-muted">
            <p className="font-medium text-fg">{user.name}</p>
            <p>{user.email}</p>
          </div>
        </DialogContent>
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sections={nav}
        subNav={subNav}
        canSearchMarkets={canSearchMarkets}
      />
    </div>
  );
}

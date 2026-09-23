'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarClock,
  Camera,
  ClipboardList,
  FileText,
  Gavel,
  Images,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  ReduceMotionToggle,
  ThemeToggle,
  cn,
} from '@simplexd/ui';
import { authClient } from '@/lib/auth/client';
import { PartnerProvider, type PartnerIdentity } from '@/lib/partner/context';
import { partnerModules, type PartnerModule } from '@/lib/partner/nav';
import { discardSessionKey } from '@/lib/partner/offline/crypto';
import { useDrafts, useOnline } from '@/lib/partner/offline/use-draft-store';
import { VerificationBadge } from './verification-badge';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  module: PartnerModule;
}

const NAV: NavItem[] = [
  { href: '/partner', label: 'Home', icon: LayoutDashboard, exact: true, module: 'home' },
  {
    href: '/partner/assignments',
    label: 'Assignments',
    icon: ClipboardList,
    module: 'assignments',
  },
  { href: '/partner/tenders', label: 'Tenders & bids', icon: Gavel, module: 'tenders' },
  { href: '/partner/rfqs', label: 'RFQs & orders', icon: Package, module: 'rfqs' },
  { href: '/partner/visits', label: 'Visits', icon: Camera, module: 'visits' },
  { href: '/partner/evidence', label: 'Evidence', icon: Images, module: 'evidence' },
  { href: '/partner/reports', label: 'Reports', icon: FileText, module: 'reports' },
  { href: '/partner/messages', label: 'Messages', icon: MessageSquare, module: 'messages' },
  { href: '/partner/notifications', label: 'Notifications', icon: Bell, module: 'notifications' },
  {
    href: '/partner/availability',
    label: 'Availability',
    icon: CalendarClock,
    module: 'availability',
  },
];

function UnsyncedIndicator({ unsynced, online }: { unsynced: number; online: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {!online ? (
        <Badge tone="warning" role="status">
          <WifiOff aria-hidden="true" className="h-3 w-3" />
          Offline
        </Badge>
      ) : null}
      {unsynced > 0 ? (
        <Link
          href="/partner/visits"
          className="sx-transition rounded-full focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Badge tone="warning" role="status">
            {unsynced} unsynced
          </Badge>
        </Link>
      ) : null}
    </div>
  );
}

export function PartnerShell({
  identity,
  children,
}: {
  identity: PartnerIdentity;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const modules = partnerModules(identity);
  const items = NAV.filter((n) => modules.has(n.module));
  const { drafts } = useDrafts(identity.userId);
  const online = useOnline();
  const unsynced = drafts.filter((d) => d.syncState !== 'synced').length;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    // Forget the offline encryption key first so drafts on a shared device become unreadable.
    discardSessionKey(identity.userId);
    await authClient.signOut();
    queryClient.clear();
    router.push('/sign-in');
    router.refresh();
  }

  const roleLabel = identity.isPartner
    ? `${identity.displayName ?? identity.name} · ${identity.partnerType ?? 'partner'}`
    : identity.isStaffInspector
      ? `${identity.name} · inspector`
      : `${identity.name} · assignee`;

  return (
    <PartnerProvider value={identity}>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#partner-main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="border-b border-border bg-bg-elevated">
          <div className="sx-container flex min-h-16 flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/partner" className="font-display text-lg font-semibold">
                SimplexD
              </Link>
              <span className="hidden text-xs uppercase tracking-wide text-fg-muted sm:inline">
                Partner workspace
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <UnsyncedIndicator unsynced={unsynced} online={online} />
              <VerificationBadge verification={identity.verification} zone={identity.timeZone} />
              <ThemeToggle compact />
              <Button
                variant="ghost"
                size="sm"
                loading={signingOut}
                onClick={() => (unsynced > 0 ? setConfirmSignOut(true) : void signOut())}
                aria-label={`Sign out ${identity.email}`}
              >
                <LogOut aria-hidden="true" className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </div>
        </header>
        {!online ? (
          <div className="sx-container pt-4">
            <Alert tone="warning" title="You are offline">
              Keep this tab open. Field drafts are saved encrypted on this device and can be opened
              from the Visits page without a connection; moving to another page or reloading needs
              the network.
            </Alert>
          </div>
        ) : null}
        <div className="sx-container flex flex-1 flex-col gap-6 py-6 md:flex-row">
          <nav aria-label="Partner workspace" className="md:w-56 md:shrink-0">
            <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible">
              {items.map((item) => {
                const current = item.exact
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
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
            <div className="mt-4 border-t border-border pt-4">
              <ReduceMotionToggle />
              <p className="mt-3 truncate text-xs text-fg-subtle" title={identity.email}>
                {roleLabel}
                <br />
                {identity.email}
              </p>
              {identity.isStaff ? (
                <Link href="/admin" className="mt-2 inline-block text-xs text-primary underline">
                  Open admin console
                </Link>
              ) : null}
            </div>
          </nav>
          <main id="partner-main" className="min-w-0 flex-1 space-y-6">
            {children}
          </main>
        </div>
      </div>
      <Dialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <DialogContent
          title={`${unsynced} draft${unsynced === 1 ? ' is' : 's are'} not on the server yet`}
          description="Signing out deletes this session's encryption key, so unsynced drafts on this device become unreadable and can only be discarded. Sync them first unless you mean to abandon them."
        >
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmSignOut(false);
                router.push('/partner/visits');
              }}
            >
              Go to visits
            </Button>
            <Button variant="danger" loading={signingOut} onClick={() => void signOut()}>
              Sign out anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PartnerProvider>
  );
}

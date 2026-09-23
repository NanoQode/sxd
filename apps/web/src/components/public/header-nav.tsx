'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Menu, Search } from 'lucide-react';
import {
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  ReduceMotionToggle,
  ThemeToggle,
} from '@simplexd/ui';
import { isActivePath, PRIMARY_LINKS, SECONDARY_LINKS, type NavServiceItem } from './nav-data';
import { SearchDialog } from './search-dialog';

export interface HeaderNavProps {
  services: NavServiceItem[];
  signedIn: boolean;
}

/**
 * Primary navigation: an accessible disclosure mega-menu for the eight
 * services on large screens, a focus-trapped drawer on small screens, and a
 * search dialog available at every size.
 */
export function HeaderNav({ services, signedIn }: HeaderNavProps) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  // The drawer is open only for the path it was opened on, so navigation closes it
  // without an effect.
  const [drawerOpenFor, setDrawerOpenFor] = useState<string | null>(null);
  const drawerOpen = drawerOpenFor === pathname;

  const accountHref = signedIn ? '/portal' : '/sign-in';
  const accountLabel = signedIn ? 'Portal' : 'Sign in';

  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <nav aria-label="Primary" className="hidden lg:block">
        <ul className="flex items-center gap-1">
          <ServicesMenu services={services} pathname={pathname} />
          {PRIMARY_LINKS.map((link) => (
            <li key={link.href}>
              <NavAnchor href={link.href} active={isActivePath(pathname, link.href)}>
                {link.label}
              </NavAnchor>
            </li>
          ))}
        </ul>
      </nav>
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="sx-transition sx-touch inline-flex items-center justify-center gap-2 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          aria-label="Search services and locations"
          aria-haspopup="dialog"
        >
          <Search aria-hidden="true" className="h-5 w-5" />
          <span className="hidden xl:inline">Search</span>
        </button>
        <ThemeToggle compact className="hidden md:inline-flex" />
        <Link
          href={accountHref}
          className={cn(buttonVariants({ variant: 'ghost' }), 'hidden md:inline-flex')}
        >
          {accountLabel}
        </Link>
        <Link
          href="/book"
          className={cn(buttonVariants({ variant: 'primary' }), 'hidden sm:inline-flex')}
        >
          Book consultation
        </Link>
        <Dialog open={drawerOpen} onOpenChange={(next) => setDrawerOpenFor(next ? pathname : null)}>
          <button
            type="button"
            onClick={() => setDrawerOpenFor(pathname)}
            className="sx-transition sx-touch inline-flex items-center justify-center rounded-md text-fg hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <Menu aria-hidden="true" className="h-6 w-6" />
          </button>
          <DialogContent
            title="Menu"
            size="sheet"
            className="inset-y-0 top-0 right-0 left-auto h-dvh max-h-dvh w-[min(360px,calc(100vw-24px))] translate-x-0 translate-y-0 rounded-none rounded-l-lg sm:top-0 sm:left-auto sm:translate-x-0 sm:translate-y-0 sm:rounded-l-lg sm:rounded-r-none"
          >
            <MobileMenu
              services={services}
              pathname={pathname}
              accountHref={accountHref}
              accountLabel={accountLabel}
            />
          </DialogContent>
        </Dialog>
      </div>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} services={services} />
    </div>
  );
}

function NavAnchor({
  href,
  active,
  children,
  className,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'sx-transition sx-touch inline-flex items-center rounded-md px-3 text-sm font-medium text-fg-muted hover:bg-bg-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active && 'text-fg underline decoration-primary decoration-2 underline-offset-8',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Disclosure pattern: button with aria-expanded controlling a region; Escape and outside interaction close it. */
function ServicesMenu({ services, pathname }: { services: NavServiceItem[]; pathname: string }) {
  // Open state is bound to the path it was opened on, so navigation closes the panel.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;
  const panelId = useId();
  const wrapRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const active = isActivePath(pathname, '/services') || isActivePath(pathname, '/pricing');

  const close = useCallback((restoreFocus = false) => {
    setOpenFor(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close(true);
    }
  };

  const onBlur = (event: React.FocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return;
    setOpenFor(null);
  };

  return (
    <li ref={wrapRef} className="relative" onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenFor(open ? null : pathname)}
        className={cn(
          'sx-transition sx-touch inline-flex items-center gap-1 rounded-md px-3 text-sm font-medium text-fg-muted hover:bg-bg-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          (active || open) && 'text-fg',
          active && 'underline decoration-primary decoration-2 underline-offset-8',
        )}
      >
        Services
        <ChevronDown
          aria-hidden="true"
          className={cn('sx-transition h-4 w-4', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="Services"
          className="absolute top-full left-0 z-50 mt-2 w-[min(760px,calc(100vw-32px))] rounded-lg border border-border bg-bg-elevated p-4 shadow-lg"
        >
          <p className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
            Eight core services
          </p>
          <ul className="grid grid-cols-2 gap-1">
            {services.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/services/${s.slug}`}
                  onClick={() => close()}
                  className="sx-transition block rounded-md px-3 py-2 hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                >
                  <span className="block text-sm font-medium text-fg">{s.name}</span>
                  <span className="block text-xs text-fg-muted">{s.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-sm">
            <Link href="/services" onClick={() => close()} className="text-primary underline">
              All services
            </Link>
            <Link href="/pricing" onClick={() => close()} className="text-primary underline">
              Pricing
            </Link>
            <Link
              href="/services#planned"
              onClick={() => close()}
              className="text-primary underline"
            >
              Planned services
            </Link>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function MobileMenu({
  services,
  pathname,
  accountHref,
  accountLabel,
}: {
  services: NavServiceItem[];
  pathname: string;
  accountHref: string;
  accountLabel: string;
}) {
  const item =
    'sx-transition sx-touch flex items-center rounded-md px-3 text-base hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus';
  return (
    <nav aria-label="Mobile" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Link href="/book" className={cn(buttonVariants({ variant: 'primary' }), 'w-full')}>
          Book consultation
        </Link>
        <Link href={accountHref} className={cn(buttonVariants({ variant: 'secondary' }), 'w-full')}>
          {accountLabel}
        </Link>
      </div>
      <details className="group rounded-md border border-border" open>
        <summary className="sx-touch flex cursor-pointer list-none items-center justify-between px-3 text-base font-medium [&::-webkit-details-marker]:hidden">
          Services
          <ChevronDown
            aria-hidden="true"
            className="sx-transition h-4 w-4 group-open:rotate-180"
          />
        </summary>
        <ul className="border-t border-border p-1">
          {services.map((s) => (
            <li key={s.slug}>
              <Link
                href={`/services/${s.slug}`}
                aria-current={pathname === `/services/${s.slug}` ? 'page' : undefined}
                className={cn(item, 'text-sm')}
              >
                {s.name}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/services" className={cn(item, 'text-sm text-primary')}>
              All services and planned services
            </Link>
          </li>
        </ul>
      </details>
      <ul className="flex flex-col">
        {PRIMARY_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              aria-current={isActivePath(pathname, link.href) ? 'page' : undefined}
              className={cn(item, isActivePath(pathname, link.href) && 'font-medium text-primary')}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col border-t border-border pt-2">
        {SECONDARY_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              aria-current={isActivePath(pathname, link.href) ? 'page' : undefined}
              className={cn(item, 'text-sm text-fg-muted')}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <ThemeToggle />
        <ReduceMotionToggle />
      </div>
    </nav>
  );
}

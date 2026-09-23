import Link from 'next/link';
import { HeaderNav } from './header-nav';
import type { NavLink, NavServiceItem } from './nav-data';

export function SiteHeader({
  services,
  signedIn,
  primaryLinks,
  secondaryLinks,
}: {
  services: NavServiceItem[];
  signedIn: boolean;
  primaryLinks?: NavLink[];
  secondaryLinks?: NavLink[];
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
      <div className="sx-container flex h-16 items-center gap-4">
        <Link
          href="/"
          className="font-display shrink-0 text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          aria-label="SimplexD home"
        >
          Simplex<span className="text-primary">D</span>
        </Link>
        <HeaderNav
          services={services}
          signedIn={signedIn}
          primaryLinks={primaryLinks}
          secondaryLinks={secondaryLinks}
        />
      </div>
    </header>
  );
}

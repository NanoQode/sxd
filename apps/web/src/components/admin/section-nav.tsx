'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SectionNavItem {
  href: string;
  label: string;
  /** Only an exact path match is active (for the section root). */
  exact?: boolean;
  /** Extra path prefixes that also mark this item active (e.g. detail pages). */
  alsoActive?: string[];
}

/** Secondary navigation inside an admin section; the active tab follows the URL. */
export function SectionNav({ items, label }: { items: SectionNavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1"
    >
      {items.map((item) => {
        const active =
          (item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`)) ||
          (item.alsoActive ?? []).some((prefix) => pathname.startsWith(prefix));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'sx-touch -mb-px inline-flex shrink-0 items-center border-b-2 border-primary px-3 text-sm font-medium text-fg'
                : 'sx-touch -mb-px inline-flex shrink-0 items-center border-b-2 border-transparent px-3 text-sm text-fg-muted hover:text-fg'
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

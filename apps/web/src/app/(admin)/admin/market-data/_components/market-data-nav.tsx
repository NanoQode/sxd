'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@simplexd/ui';

const links = [
  {
    href: '/admin/market-data',
    label: 'Markets',
    exact: false,
    prefix: '/admin/market-data/markets',
  },
  { href: '/admin/market-data/observations', label: 'Observations' },
  { href: '/admin/market-data/sources', label: 'Sources' },
  { href: '/admin/market-data/imports', label: 'Imports' },
  { href: '/admin/market-data/exports', label: 'Export' },
  { href: '/admin/market-data/ranking-policies', label: 'Ranking policies' },
  { href: '/admin/market-data/freshness', label: 'Freshness' },
  { href: '/admin/market-data/data-policies', label: 'Data policy' },
];

export function MarketDataNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Market data" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1 border-b border-border">
        {links.map((l) => {
          const active =
            pathname === l.href ||
            (l.href !== '/admin/market-data' && pathname.startsWith(`${l.href}/`)) ||
            (l.prefix ? pathname.startsWith(l.prefix) : false);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'sx-transition sx-touch -mb-px inline-flex items-center whitespace-nowrap border-b-2 px-3 text-sm',
                  active
                    ? 'border-primary font-medium text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

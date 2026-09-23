import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { breadcrumbJsonLd, JsonLd } from './json-ld';

export interface Crumb {
  name: string;
  href: string;
}

export function Breadcrumbs({ items, baseUrl }: { items: Crumb[]; baseUrl: string }) {
  const all: Crumb[] = [{ name: 'Home', href: '/' }, ...items];
  return (
    <nav aria-label="Breadcrumb" className="sx-container pt-4 text-sm text-fg-muted">
      <ol className="flex flex-wrap items-center gap-1">
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <li key={c.href} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="text-fg">
                  {c.name}
                </span>
              ) : (
                <Link href={c.href} className="hover:text-fg hover:underline">
                  {c.name}
                </Link>
              )}
              {!last ? <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /> : null}
            </li>
          );
        })}
      </ol>
      <JsonLd data={breadcrumbJsonLd(all.map((c) => ({ name: c.name, url: `${baseUrl}${c.href}` })))} />
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { cn, Dialog, DialogContent, Input } from '@simplexd/ui';
import type { NavServiceItem } from './nav-data';
import {
  normalizeQuery,
  searchMarkets,
  searchPages,
  searchServices,
  type SearchableMarket,
  type SearchResult,
} from './search';

interface CatalogService extends NavServiceItem {
  category?: 'core' | 'expansion';
}

interface MarketsState {
  status: 'ready' | 'loading' | 'unavailable';
  items: SearchableMarket[];
}

/**
 * Header search: services (client-side over the public catalogue), published
 * markets (server query) and static pages. Degrades honestly when the markets
 * API is not available yet.
 */
export function SearchDialog({
  open,
  onOpenChange,
  services,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: NavServiceItem[];
}) {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [markets, setMarkets] = useState<MarketsState>({ status: 'ready', items: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  // Load the full catalogue (core + planned) once the dialog is first opened.
  useEffect(() => {
    if (!open || catalog !== null) return;
    let cancelled = false;
    fetch('/api/v1/services')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { items: Array<{ slug: string; name: string; shortDescription: string; category: 'core' | 'expansion' }> }) => {
        if (cancelled) return;
        setCatalog(
          data.items.map((i) => ({
            slug: i.slug,
            name: i.name,
            hint: i.shortDescription,
            category: i.category,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setCatalog(services);
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalog, services]);

  // Debounced market search against the public markets API. State changes only
  // happen inside the timer/fetch callbacks, never synchronously in the effect.
  const q = normalizeQuery(query);
  useEffect(() => {
    if (!open || q.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      setMarkets((m) => ({ status: 'loading', items: m.items }));
      fetch(`/api/v1/markets?q=${encodeURIComponent(q)}&limit=8`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: { items?: Array<{ slug: string; name: string; stateName: string; aliases?: string[] }> }) => {
          if (cancelled) return;
          setMarkets({
            status: 'ready',
            items: (data.items ?? []).map((m) => ({
              slug: m.slug,
              name: m.name,
              stateName: m.stateName,
              aliases: m.aliases,
            })),
          });
        })
        .catch(() => {
          if (!cancelled) setMarkets({ status: 'unavailable', items: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open]);

  const results = useMemo(() => {
    const list: SearchResult[] = [
      ...searchServices(catalog ?? services, query),
      ...(q.length >= 2 ? searchMarkets(markets.items, query) : []),
      ...searchPages(query),
    ];
    return list;
  }, [catalog, services, markets.items, query, q]);

  const grouped = {
    services: results.filter((r) => r.group === 'services'),
    locations: results.filter((r) => r.group === 'locations'),
    pages: results.filter((r) => r.group === 'pages'),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Search"
        description="Find a service, a location or a page."
        size="lg"
        className="sm:max-w-xl"
      >
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Try “due diligence” or “Ibadan”"
            aria-label="Search services, locations and pages"
            aria-controls={resultsId}
            autoComplete="off"
            className="pl-9"
          />
        </div>
        <div id={resultsId} aria-live="polite" className="mt-4 space-y-4">
          {q.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Type at least two characters. Locations are searched among published markets only.
            </p>
          ) : null}
          {q.length > 0 && results.length === 0 && (markets.status !== 'loading' || q.length < 2) ? (
            <p className="text-sm text-fg-muted">No matches for “{query}”.</p>
          ) : null}
          <ResultGroup title="Services" items={grouped.services} onNavigate={() => onOpenChange(false)} />
          <ResultGroup
            title="Locations"
            items={grouped.locations}
            onNavigate={() => onOpenChange(false)}
            footer={
              markets.status === 'loading' && q.length >= 2 ? (
                <p className="text-xs text-fg-muted">Searching locations…</p>
              ) : markets.status === 'unavailable' && q.length >= 2 ? (
                <p className="text-xs text-fg-muted">
                  Location search is not available yet. Browse{' '}
                  <Link href="/locations" className="text-primary underline" onClick={() => onOpenChange(false)}>
                    all locations
                  </Link>
                  .
                </p>
              ) : null
            }
          />
          <ResultGroup title="Pages" items={grouped.pages} onNavigate={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultGroup({
  title,
  items,
  onNavigate,
  footer,
}: {
  title: string;
  items: SearchResult[];
  onNavigate: () => void;
  footer?: React.ReactNode;
}) {
  if (items.length === 0 && !footer) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">{title}</h3>
      {items.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((r) => (
            <li key={`${r.group}-${r.href}`}>
              <Link
                href={r.href}
                onClick={onNavigate}
                className={cn(
                  'sx-transition block px-3 py-2 hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
                )}
              >
                <span className="block text-sm font-medium">{r.title}</span>
                {r.subtitle ? <span className="block text-xs text-fg-muted">{r.subtitle}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {footer ? <div className="mt-1">{footer}</div> : null}
    </section>
  );
}

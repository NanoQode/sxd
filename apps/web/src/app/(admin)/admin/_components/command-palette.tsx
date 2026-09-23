'use client';

import { CornerDownLeft, MapPin, PanelsTopLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, Spinner, cn } from '@simplexd/ui';
import type { AdminMarketRow } from '@simplexd/contracts';
import { apiFetch } from '@/lib/api/client-fetch';
import type { NavItem, SubNavItem } from '../_lib/navigation';

interface Result {
  id: string;
  label: string;
  hint: string;
  href: string;
  kind: 'section' | 'market';
}

/**
 * Searchable global navigation: sections, sub-sections and markets by name
 * or alias. Implemented as an accessible combobox (listbox with
 * aria-activedescendant) so it needs no extra dependency.
 */
export function CommandPalette({
  open,
  onOpenChange,
  sections,
  subNav,
  canSearchMarkets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: NavItem[];
  subNav: SubNavItem[];
  canSearchMarkets: boolean;
}) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [markets, setMarkets] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setMarkets([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !canSearchMarkets || query.trim().length < 2) {
      setMarkets([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiFetch<{ items: AdminMarketRow[] }>(
          `/api/v1/admin/markets?q=${encodeURIComponent(query.trim())}&pageSize=8`,
          { signal: controller.signal },
        );
        setMarkets(
          res.items.map((m) => ({
            id: `market-${m.id}`,
            label: m.name,
            hint: `${m.stateName} · ${m.publicationState.replace(/_/g, ' ')}`,
            href: `/admin/market-data/markets/${m.id}`,
            kind: 'market',
          })),
        );
      } catch {
        if (!controller.signal.aborted) setMarkets([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, canSearchMarkets]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const sectionResults: Result[] = [
      ...sections.map((s) => ({ id: `section-${s.key}`, label: s.label, hint: s.plannedWave ? `Planned for wave ${s.plannedWave}` : 'Section', href: s.href, kind: 'section' as const })),
      ...subNav.map((s) => ({ id: `sub-${s.href}`, label: s.label, hint: sections.find((n) => n.key === s.parent)?.label ?? 'Page', href: s.href, kind: 'section' as const })),
    ].filter((r) => !q || r.label.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q));
    return [...sectionResults.slice(0, q ? 12 : 30), ...markets];
  }, [query, sections, subNav, markets]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  function go(result: Result | undefined) {
    if (!result) return;
    onOpenChange(false);
    router.push(result.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Search" description="Jump to a section or a market by name or alias." size="md">
        <div className="space-y-3">
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search sections and markets"
            placeholder="Type to search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="sx-transition h-11 w-full rounded-md border border-border-strong bg-bg-elevated px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus sm:text-sm"
          />
          <ul id={listId} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto">
            {results.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-fg-muted" role="presentation">
                {loading ? <Spinner className="mx-auto" /> : 'No matches.'}
              </li>
            ) : null}
            {results.map((r, i) => {
              const Icon = r.kind === 'market' ? MapPin : PanelsTopLeft;
              return (
                <li
                  key={r.id}
                  id={`${listId}-${r.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn(
                    'sx-touch flex cursor-pointer items-center gap-3 rounded-md px-3 text-sm',
                    i === active ? 'bg-primary-soft text-primary' : 'hover:bg-bg-sunken',
                  )}
                >
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.label}</span>
                    <span className="block truncate text-xs text-fg-muted">{r.hint}</span>
                  </span>
                  {i === active ? <CornerDownLeft aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
                </li>
              );
            })}
            {loading && results.length > 0 ? (
              <li className="px-3 py-2 text-xs text-fg-muted" role="presentation">
                Searching markets…
              </li>
            ) : null}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

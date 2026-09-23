import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@simplexd/ui';

export interface SectionTab {
  value: string;
  label: string;
  /** Small count or badge rendered after the label. */
  badge?: ReactNode;
}

/**
 * Link-driven tabs for server-rendered detail pages: the active tab is the
 * `tab` search parameter, so every tab is a real URL (bookmarkable, back
 * button works, no client state to hydrate). Rendered as navigation, not as
 * an ARIA tablist, because each tab is a separate request.
 */
export function SectionTabs({
  basePath,
  tabs,
  active,
  label,
  extraParams,
}: {
  basePath: string;
  tabs: SectionTab[];
  active: string;
  label: string;
  extraParams?: Record<string, string>;
}) {
  const query = (value: string) => {
    const params = new URLSearchParams(extraParams);
    params.set('tab', value);
    return `${basePath}?${params.toString()}`;
  };
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {tabs.map((tab) => {
          const current = tab.value === active;
          return (
            <li key={tab.value}>
              <Link
                href={query(tab.value)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'sx-transition sx-touch -mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm',
                  current
                    ? 'border-primary font-medium text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
              >
                {tab.label}
                {tab.badge ? <span>{tab.badge}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Picks a valid tab from the search parameter, defaulting to the first. */
export function resolveTab<T extends string>(
  candidate: string | undefined,
  values: readonly T[],
): T {
  return (values as readonly string[]).includes(candidate ?? '') ? (candidate as T) : values[0]!;
}

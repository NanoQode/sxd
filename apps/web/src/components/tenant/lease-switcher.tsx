import Link from 'next/link';
import { cn } from '@simplexd/ui';

/** Picks which of the caller's leases a page shows (only rendered with two or more). */
export function LeaseSwitcher({
  leases,
  selectedId,
  basePath,
}: {
  leases: Array<{ id: string; title: string; status: string }>;
  selectedId: string;
  basePath: string;
}) {
  if (leases.length < 2) return null;
  return (
    <nav aria-label="Choose a lease">
      <ul className="flex flex-wrap gap-2">
        {leases.map((l) => {
          const current = l.id === selectedId;
          return (
            <li key={l.id}>
              <Link
                href={`${basePath}?lease=${l.id}`}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'sx-transition sx-touch inline-flex items-center rounded-md border px-3 text-sm',
                  current
                    ? 'border-primary bg-primary-soft font-medium text-primary'
                    : 'border-border hover:bg-bg-sunken',
                )}
              >
                {l.title}
                {l.status !== 'active' ? (
                  <span className="ml-1 text-xs text-fg-muted">({l.status.replace(/_/g, ' ')})</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

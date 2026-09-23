'use client';

import { parseAsInteger, useQueryState } from 'nuqs';
import { Button } from '@simplexd/ui';

/** Stable table pagination driven by the `page` URL parameter (server re-renders on change). */
export function Pagination({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const [, setPage] = useQueryState('page', parseAsInteger.withDefault(1).withOptions({ shallow: false }));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg-muted">
      <p>
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </Button>
        <span aria-current="page">
          Page {page} of {pages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

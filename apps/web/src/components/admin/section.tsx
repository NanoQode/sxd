import Link from 'next/link';
import type { ReactNode } from 'react';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';

/** Titled card section used across admin detail pages. */
export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Card id={id}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  );
}

/**
 * Honest notice for a control that depends on a server capability that does
 * not exist yet: says what is missing instead of showing a dead button.
 */
export function GapNotice({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Alert tone="info" title={title}>
      {children}{' '}
      <Link href="/admin/implementation-status" className="font-medium underline">
        Implementation status
      </Link>
      .
    </Alert>
  );
}

export function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'sx-touch -mb-px inline-flex items-center border-b-2 border-primary px-3 text-sm font-medium text-fg'
          : 'sx-touch -mb-px inline-flex items-center border-b-2 border-transparent px-3 text-sm text-fg-muted hover:text-fg'
      }
    >
      {children}
    </Link>
  );
}

export function TabNav({ children, label }: { children: ReactNode; label: string }) {
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border">
      {children}
    </nav>
  );
}

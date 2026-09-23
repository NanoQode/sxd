import type { ReactNode } from 'react';
import { cn } from '@simplexd/ui';

/** Labelled page section with consistent spacing and heading hierarchy. */
export function Section({
  id,
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 2,
  tone = 'default',
}: {
  id: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  tone?: 'default' | 'sunken';
}) {
  const headingId = `${id}-heading`;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('py-10 sm:py-14', tone === 'sunken' && 'bg-bg-sunken', className)}
    >
      <div className="sx-container">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            {eyebrow ? (
              <p className="text-xs font-medium tracking-wide text-primary uppercase">{eyebrow}</p>
            ) : null}
            <Heading
              id={headingId}
              className={cn(
                'font-display font-semibold leading-tight',
                headingLevel === 2 ? 'mt-1 text-2xl sm:text-3xl' : 'mt-1 text-xl sm:text-2xl',
              )}
            >
              {title}
            </Heading>
            {description ? <p className="mt-2 text-fg-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {children ? <div className="mt-6 sm:mt-8">{children}</div> : null}
      </div>
    </section>
  );
}

/** Narrow content column for long-form pages. */
export function Prose({ html, className }: { html: string; className?: string }) {
  return <div className={cn('sx-prose max-w-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

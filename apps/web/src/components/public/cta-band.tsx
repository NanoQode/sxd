import Link from 'next/link';
import { buttonVariants, cn } from '@simplexd/ui';

export function CtaBand({
  title = 'Ready to start with evidence?',
  description = 'Explore locations anonymously, then send a consultation request that carries your selections.',
  primary = { label: 'Book a consultation', href: '/book' },
  secondary = { label: 'Explore where to build', href: '/explore' },
}: {
  title?: string;
  description?: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string } | null;
}) {
  return (
    <section aria-labelledby="cta-band-heading" className="py-10 sm:py-14">
      <div className="sx-container">
        <div className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-primary-soft p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="max-w-2xl">
            <h2 id="cta-band-heading" className="font-display text-xl font-semibold sm:text-2xl">
              {title}
            </h2>
            <p className="mt-1 text-fg-muted">{description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {secondary ? (
              <Link href={secondary.href} className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }))}>
                {secondary.label}
              </Link>
            ) : null}
            <Link href={primary.href} className={cn(buttonVariants({ size: 'lg' }))}>
              {primary.label}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge, cn } from '@simplexd/ui';
import type { ServiceCatalogItem } from '@/server/services/catalog';
import { ServiceIcon } from './service-icon';

/** Service card with concrete deliverables and the editable price anchor. */
export function ServiceCard({
  service,
  highlighted = false,
  compact = false,
}: {
  service: ServiceCatalogItem;
  highlighted?: boolean;
  compact?: boolean;
}) {
  const pkg = service.primaryPackage;
  const planned = service.category === 'expansion';
  return (
    <article
      className={cn(
        'sx-transition-base flex h-full flex-col rounded-lg border bg-bg-elevated p-5 shadow-sm',
        highlighted ? 'border-primary ring-2 ring-primary/30' : 'border-border',
      )}
      aria-labelledby={`svc-${service.slug}`}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
          <ServiceIcon iconKey={service.iconKey} />
        </span>
        <div className="min-w-0">
          <h3 id={`svc-${service.slug}`} className="text-base font-semibold leading-tight">
            <Link
              href={`/services/${service.slug}`}
              className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {service.name}
            </Link>
          </h3>
          {highlighted ? (
            <Badge tone="primary" className="mt-1">
              Matches your goal
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-fg-muted">{service.shortDescription}</p>
      {!compact && service.deliverables.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {service.deliverables.slice(0, 3).map((d) => (
            <li key={d} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              />
              <span>{d}</span>
            </li>
          ))}
          {service.deliverables.length > 3 ? (
            <li className="text-xs text-fg-subtle">
              + {service.deliverables.length - 3} more deliverable
              {service.deliverables.length - 3 > 1 ? 's' : ''}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-auto pt-4">
        <p className="text-sm">
          <span className="text-fg-muted">{planned ? 'Availability: ' : 'Price anchor: '}</span>
          <span className="font-medium">
            {planned
              ? 'Inquiry only, not yet bookable'
              : (pkg?.priceLabel ?? 'Indicative price under business review')}
          </span>
        </p>
        {!planned && pkg && pkg.publicationState === 'published' ? (
          <p className="text-xs text-fg-subtle">
            Basis stated on the service page; final price by scoped quotation.
          </p>
        ) : null}
        <span className="relative mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary">
          {planned ? 'Register interest' : 'View service'}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </span>
      </div>
    </article>
  );
}

/** Position wrapper so the whole card is clickable via the title link. */
export function ServiceCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>article]:relative">{children}</div>
  );
}

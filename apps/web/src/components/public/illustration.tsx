import Image from 'next/image';
import { cn } from '@simplexd/ui';

/**
 * Neutral first-party SVG illustrations (no photography until approved brand
 * assets arrive). Served from /public/images with explicit dimensions so the
 * layout never shifts.
 */
const catalog = {
  'site-plan': { src: '/images/site-plan.svg', width: 640, height: 480, alt: '' },
  'evidence-report': { src: '/images/evidence-report.svg', width: 640, height: 480, alt: '' },
  coordination: { src: '/images/coordination.svg', width: 640, height: 480, alt: '' },
  'map-pins': { src: '/images/map-pins.svg', width: 640, height: 480, alt: '' },
} as const;

export type IllustrationName = keyof typeof catalog;

export function Illustration({
  name,
  className,
  alt = '',
  priority = false,
}: {
  name: IllustrationName;
  className?: string;
  alt?: string;
  priority?: boolean;
}) {
  const img = catalog[name];
  return (
    <Image
      src={img.src}
      width={img.width}
      height={img.height}
      alt={alt}
      priority={priority}
      className={cn('h-auto w-full', className)}
    />
  );
}

import { cn } from '../cn';

/** Use only while actual loading occurs. */
export function Skeleton({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('sx-skeleton h-4 w-full', className)} />
  );
}

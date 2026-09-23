import Link from 'next/link';
import type { ComponentProps } from 'react';
import { buttonVariants, cn } from '@simplexd/ui';

type Variant = NonNullable<Parameters<typeof buttonVariants>[0]>['variant'];
type Size = NonNullable<Parameters<typeof buttonVariants>[0]>['size'];

/** Next.js link that looks like a button (keeps navigation as navigation). */
export function LinkButton({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

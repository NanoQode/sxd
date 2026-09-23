'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** Accessible modal with focus trapping and restoration provided by Radix. */
export function DialogContent({
  title,
  description,
  children,
  className,
  size = 'md',
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'sheet';
}) {
  const width =
    size === 'sm'
      ? 'max-w-sm'
      : size === 'lg'
        ? 'max-w-3xl'
        : size === 'sheet'
          ? 'max-w-none sm:max-w-lg'
          : 'max-w-lg';
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="sx-transition-base fixed inset-0 z-50 bg-[var(--sx-bg-overlay)] data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex max-h-[90dvh] w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-lg focus:outline-none',
          size === 'sheet'
            ? 'inset-x-0 bottom-0 w-full rounded-b-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg'
            : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
          width,
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-base font-semibold">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-sm text-fg-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            aria-label="Close dialog"
            className="sx-touch -m-2 flex shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-sunken hover:text-fg"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </DialogPrimitive.Close>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}>
      {children}
    </div>
  );
}

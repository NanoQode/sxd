'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { buttonVariants, cn } from '@simplexd/ui';

/**
 * Contextual sticky primary action for small screens. Pages register their
 * own action with <PageAction/>; otherwise the bar offers a consultation.
 * Hidden on pages that already show a form as their main content.
 */

export interface BarAction {
  label: string;
  href: string;
  secondary?: { label: string; href: string };
}

interface ActionBarContextValue {
  action: BarAction | null;
  setAction: (action: BarAction | null) => void;
}

const ActionBarContext = createContext<ActionBarContextValue | null>(null);

export function ActionBarProvider({ children }: { children: ReactNode }) {
  const [action, setAction] = useState<BarAction | null>(null);
  const value = useMemo(() => ({ action, setAction }), [action]);
  return <ActionBarContext.Provider value={value}>{children}</ActionBarContext.Provider>;
}

export function PageAction({ label, href, secondary }: BarAction) {
  const ctx = useContext(ActionBarContext);
  const secondaryLabel = secondary?.label;
  const secondaryHref = secondary?.href;
  useEffect(() => {
    if (!ctx) return;
    ctx.setAction({
      label,
      href,
      secondary: secondaryLabel && secondaryHref ? { label: secondaryLabel, href: secondaryHref } : undefined,
    });
    return () => ctx.setAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx.setAction is stable
  }, [label, href, secondaryLabel, secondaryHref]);
  return null;
}

const HIDDEN_ON = ['/book', '/contact'];

export function StickyActionBar() {
  const ctx = useContext(ActionBarContext);
  const pathname = usePathname();
  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  const action = ctx?.action ?? { label: 'Book a consultation', href: '/book' };
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-elevated/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
      role="region"
      aria-label="Primary action"
    >
      <div className={cn('flex gap-2', action.secondary && 'grid grid-cols-2')}>
        {action.secondary ? (
          <Link
            href={action.secondary.href}
            className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'w-full')}
          >
            {action.secondary.label}
          </Link>
        ) : null}
        <Link href={action.href} className={cn(buttonVariants({ size: 'lg' }), 'w-full')}>
          {action.label}
        </Link>
      </div>
    </div>
  );
}

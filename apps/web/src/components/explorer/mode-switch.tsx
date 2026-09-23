'use client';

import { BookOpen, Calculator } from 'lucide-react';
import { cn } from '@simplexd/ui';
import { COPY, type ExplorerMode } from '@/lib/explorer';

/**
 * Evidence mode versus assumption mode. Assumption mode is a visibly separate
 * mode: it is announced in the control, in a banner and in every result.
 */
export function ModeSwitch({
  mode,
  onChange,
  className,
}: {
  mode: ExplorerMode;
  onChange: (mode: ExplorerMode) => void;
  className?: string;
}) {
  const options: Array<{ value: ExplorerMode; label: string; icon: typeof BookOpen; hint: string }> = [
    { value: 'evidence', label: 'Evidence mode', icon: BookOpen, hint: COPY.evidenceModeHint },
    { value: 'assumption', label: 'Assumption mode', icon: Calculator, hint: COPY.assumptionModeBanner },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Ranking mode"
      className={cn('inline-flex rounded-md border border-border bg-bg-elevated p-0.5', className)}
    >
      {options.map(({ value, label, icon: Icon, hint }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={hint}
            onClick={() => onChange(value)}
            className={cn(
              'sx-transition sx-touch inline-flex items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active
                ? value === 'assumption'
                  ? 'bg-gold-soft text-fg'
                  : 'bg-primary-soft text-primary'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

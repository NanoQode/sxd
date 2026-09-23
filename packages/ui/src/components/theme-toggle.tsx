'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from '../theme/theme-provider';
import { cn } from '../cn';

const options: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Clearly labelled sun/moon/system control (radio group semantics). */
export function ThemeToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('inline-flex rounded-md border border-border bg-bg-elevated p-0.5', className)}
    >
      {options.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={compact ? `${label} theme` : undefined}
            onClick={() => setTheme(value)}
            className={cn(
              'sx-transition sx-touch inline-flex items-center gap-1.5 rounded-[6px] px-2.5 text-sm',
              active ? 'bg-primary-soft text-primary' : 'text-fg-muted hover:text-fg',
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {!compact ? <span>{label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ReduceMotionToggle({ className }: { className?: string }) {
  const { motion, setMotion } = useTheme();
  const reduce = motion === 'reduce';
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm', className)}>
      <input
        type="checkbox"
        className="h-4 w-4 accent-[var(--sx-primary)]"
        checked={reduce}
        onChange={(e) => setMotion(e.target.checked ? 'reduce' : 'system')}
      />
      Reduce motion
    </label>
  );
}

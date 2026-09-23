'use client';

import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../cn';

export function Switch({
  checked,
  onCheckedChange,
  id,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'sx-transition relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border-strong bg-bg-sunken data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60',
        className,
      )}
    >
      <SwitchPrimitive.Thumb className="sx-transition block h-5 w-5 translate-x-1 rounded-full bg-bg-elevated shadow data-[state=checked]:translate-x-6" />
    </SwitchPrimitive.Root>
  );
}

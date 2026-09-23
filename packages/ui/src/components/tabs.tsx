'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'sx-transition sx-touch -mb-px whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-fg-muted hover:text-fg data-[state=active]:border-primary data-[state=active]:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsPrimitive.TabsContentProps) {
  return (
    <TabsPrimitive.Content
      className={cn('pt-4 focus-visible:outline-none', className)}
      {...props}
    />
  );
}

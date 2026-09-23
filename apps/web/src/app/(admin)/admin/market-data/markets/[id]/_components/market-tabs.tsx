'use client';

import { parseAsString, useQueryState } from 'nuqs';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@simplexd/ui';

/** Tab strip whose selection lives in the `tab` URL parameter so links can deep-link a tab. */
export function MarketTabs({
  tabs,
  initialTab,
}: {
  tabs: Array<{ key: string; label: string; content: ReactNode }>;
  initialTab?: string;
}) {
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsString.withDefault(
      initialTab && tabs.some((t) => t.key === initialTab) ? initialTab : 'profile',
    ),
  );
  return (
    <Tabs value={tab} onValueChange={(v) => void setTab(v === 'profile' ? null : v)}>
      <TabsList aria-label="Market sections">
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key}>
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

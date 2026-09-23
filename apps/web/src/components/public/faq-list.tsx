import { ChevronDown } from 'lucide-react';
import type { FaqItem } from './defaults';

/** Native disclosure accordion: keyboard accessible without JavaScript. */
export function FaqList({ items }: { items: FaqItem[] }) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-bg-elevated">
      {items.map((item, i) => (
        <details key={item.question} className="group" open={i === 0}>
          <summary className="sx-touch flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-left font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <span>{item.question}</span>
            <ChevronDown
              aria-hidden="true"
              className="sx-transition h-4 w-4 shrink-0 text-fg-muted group-open:rotate-180"
            />
          </summary>
          <div
            className="sx-prose px-4 pb-4 text-sm text-fg-muted"
            dangerouslySetInnerHTML={{ __html: item.answerHtml }}
          />
        </details>
      ))}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Info, Megaphone, TriangleAlert, X } from 'lucide-react';
import { cn } from '@simplexd/ui';
import type { SiteBanner } from './site-content';

const STORAGE_KEY = 'sx_banners_dismissed';

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    // Keep the list bounded: only ids of banners that can still be live matter.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-20)));
  } catch {
    /* storage unavailable (private mode); the banner simply shows again next visit */
  }
}

const tones = {
  info: { icon: Info, className: 'border-info/40 bg-info-soft text-fg' },
  warning: { icon: TriangleAlert, className: 'border-warning/50 bg-warning-soft text-fg' },
  success: { icon: Megaphone, className: 'border-success/40 bg-success-soft text-fg' },
} as const;

/**
 * Site-wide announcement banners from published `banner` pages. Rendered on
 * the server with the sanitised content; dismissal is remembered per visitor
 * in localStorage keyed by publication, so a republished banner reappears.
 * Until hydration every banner is visible, which is the honest default.
 */
export function SiteBanners({ banners }: { banners: SiteBanner[] }) {
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);
  const visible = banners.filter((b) => !dismissed || !dismissed.includes(b.id));
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    const next = [...(dismissed ?? readDismissed()), id];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div role="region" aria-label="Announcements" className="border-b border-border">
      {visible.map((banner) => {
        const tone = tones[banner.tone];
        const Icon = tone.icon;
        return (
          <div key={banner.id} className={cn('border-b last:border-b-0', tone.className)}>
            <div className="sx-container flex items-start gap-3 py-2.5 text-sm">
              <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                {banner.bodyHtml ? (
                  <div
                    className="[&_a]:underline [&_p]:inline"
                    dangerouslySetInnerHTML={{ __html: banner.bodyHtml }}
                  />
                ) : (
                  <span>{banner.message}</span>
                )}
                {banner.href ? (
                  <>
                    {' '}
                    <Link href={banner.href} className="font-medium underline">
                      {banner.linkLabel}
                    </Link>
                  </>
                ) : null}
              </div>
              {banner.dismissible ? (
                <button
                  type="button"
                  onClick={() => dismiss(banner.id)}
                  className="sx-transition -m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-bg/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  aria-label="Dismiss announcement"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

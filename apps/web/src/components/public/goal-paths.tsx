import Link from 'next/link';
import { ArrowRight, Compass, Hammer, KeyRound, TrendingUp, type LucideIcon } from 'lucide-react';
import { buttonVariants, cn } from '@simplexd/ui';
import { GOAL_PATHS, type GoalKey } from './defaults';

const icons: Record<GoalKey, LucideIcon> = {
  buy_safely: KeyRound,
  build_with_oversight: Hammer,
  manage_property: Compass,
  invest_and_compare: TrendingUp,
};

export function GoalPaths({ serviceNames }: { serviceNames: Record<string, string> }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {GOAL_PATHS.map((goal) => {
        const Icon = icons[goal.key];
        return (
          <li
            key={goal.key}
            className="flex flex-col rounded-lg border border-border bg-bg-elevated p-5 shadow-sm"
          >
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-gold-soft text-fg">
              <Icon aria-hidden="true" className="h-5 w-5" />
            </span>
            <h3 className="mt-3 text-base font-semibold">{goal.title}</h3>
            <p className="mt-1 text-sm text-fg-muted">{goal.description}</p>
            <p className="mt-2 text-xs text-fg-subtle">
              {goal.serviceSlugs.map((s) => serviceNames[s] ?? s).join(' · ')}
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              <Link
                href={goal.href}
                className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
              >
                Start
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
              {goal.exploreHref !== goal.href ? (
                <Link
                  href={goal.exploreHref}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                >
                  Explore locations
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

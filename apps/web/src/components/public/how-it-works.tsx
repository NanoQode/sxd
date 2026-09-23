import { HOW_IT_WORKS_STEPS, SAMPLE_REPORTS, SAMPLE_REPORTS_NOTE } from './defaults';
import Link from 'next/link';

export function WorkflowSteps({ compact = false }: { compact?: boolean }) {
  return (
    <ol className={compact ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-4'}>
      {HOW_IT_WORKS_STEPS.map((step, i) => (
        <li
          key={step.key}
          className="flex gap-4 rounded-lg border border-border bg-bg-elevated p-4"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-fg-on-primary"
          >
            {i + 1}
          </span>
          <div>
            <h3 className="text-base font-semibold">
              <span className="sr-only">Step {i + 1}: </span>
              {step.title}
            </h3>
            <p className="mt-1 text-sm text-fg-muted">{step.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SampleReports() {
  return (
    <div>
      <p className="mb-4 max-w-prose text-sm text-fg-muted">{SAMPLE_REPORTS_NOTE}</p>
      <div className="grid gap-4 md:grid-cols-3">
        {SAMPLE_REPORTS.map((report) => (
          <article
            key={report.title}
            className="rounded-lg border border-border bg-bg-elevated p-4"
          >
            <h3 className="text-base font-semibold">{report.title}</h3>
            <p className="mt-1 text-xs text-fg-subtle">
              Produced by{' '}
              <Link href={`/services/${report.serviceSlug}`} className="text-primary underline">
                {report.serviceSlug.replace(/-/g, ' ')}
              </Link>
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-fg-muted">
              {report.contains.map((c) => (
                <li key={c} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}

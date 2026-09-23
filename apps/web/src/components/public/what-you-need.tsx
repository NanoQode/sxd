import { stageLabel, type EngagementStage } from '@/lib/services/document-requirements';

export interface PublicRequirement {
  id: string;
  name: string;
  description: string | null;
  stage: EngagementStage | null;
  required: boolean;
}

/**
 * "What you'll need" on a public service page: the non-sensitive documents
 * the service asks for, editable by the business. Identity documents are
 * never listed here; they are requested inside a request only when the
 * transaction needs them.
 */
export function WhatYouNeed({ items }: { items: PublicRequirement[] }) {
  return (
    <section aria-labelledby="what-you-need-heading" className="mt-8">
      <h2 id="what-you-need-heading" className="text-xl font-semibold">
        What you&apos;ll need
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 max-w-prose text-sm text-fg-muted">
          No documents are needed to start; the team tells you during triage if anything is required.
        </p>
      ) : (
        <>
          <p className="mt-2 max-w-prose text-sm text-fg-muted">
            You can start with what you have; the team asks for the rest as the engagement moves on.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {items.map((r) => (
              <li key={r.id} className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm">
                <p className="font-medium">
                  {r.name}
                  {!r.required ? <span className="text-fg-muted"> (optional)</span> : null}
                </p>
                <p className="text-xs text-fg-muted">
                  {stageLabel(r.stage)}
                  {r.description ? ` · ${r.description}` : ''}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-subtle">
            Identity documents are requested only when a transaction requires them, inside your
            request, never here.
          </p>
        </>
      )}
    </section>
  );
}

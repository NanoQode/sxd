import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@simplexd/ui';
import {
  SENSITIVE_DOCUMENT_NOTE,
  requirementsForStage,
  stageLabel,
  type EngagementStage,
  type RequirementLike,
} from '@/lib/services/document-requirements';

/**
 * "Documents we need" on a customer's request: the requirements that apply
 * to the service, split into what is needed by the current stage and what
 * comes later. Uploads are not linked to requirements yet, so the list says
 * what to upload and the team confirms each document; nothing is ticked off
 * automatically.
 */
export function DocumentsWeNeed({
  requirements,
  serviceId,
  stage,
}: {
  requirements: RequirementLike[];
  serviceId: string;
  stage: EngagementStage | null;
}) {
  const { now, later } = requirementsForStage(requirements, {
    serviceId,
    stage,
    includeSensitive: true,
  });
  const anySensitive = [...now, ...later].some((r) => r.sensitive);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents we need</CardTitle>
        <CardDescription>
          {stage === null
            ? 'This request is closed, so nothing further is needed.'
            : now.length === 0
              ? 'Nothing is needed from you at this stage.'
              : 'Upload these in the Documents list below. The team confirms each one; nothing is ticked off automatically.'}
        </CardDescription>
      </CardHeader>
      {now.length > 0 || later.length > 0 ? (
        <CardContent className="space-y-4 text-sm">
          {now.length > 0 ? (
            <ul className="space-y-2">
              {now.map((r) => (
                <li key={r.id} className="rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {r.name}
                    <Badge tone={r.required ? 'primary' : 'neutral'}>
                      {r.required ? 'Required' : 'Optional'}
                    </Badge>
                    {r.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                  </p>
                  {r.description ? <p className="mt-1 text-fg-muted">{r.description}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {later.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-fg-muted">
                Needed later ({later.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {later.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <span>{r.name}</span>
                    <span className="text-xs text-fg-muted">{stageLabel(r.stage)}</span>
                    {r.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {anySensitive ? <p className="text-xs text-fg-muted">{SENSITIVE_DOCUMENT_NOTE}</p> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

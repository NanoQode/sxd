'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { EngagementItemDto, FileDto } from '@simplexd/contracts';
import { Alert, Button, Field, Textarea, useToast } from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { FileUploader } from '@/components/portal/file-uploader';

/**
 * What a customer can do on an item: answer a query and upload the
 * documents a checklist item asks for. Both controls appear only when the
 * server said the caller may use them (`item.can`), so nothing here is a
 * dead button; the API re-checks every call.
 */
export function CustomerItemActions({
  item,
  serviceRequestId,
}: {
  item: EngagementItemDto;
  serviceRequestId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [version, setVersion] = useState(item.version);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  useEffect(() => setVersion(item.version), [item.version]);

  if (!item.can.respond && !item.can.attachEvidence) return null;

  async function respond() {
    if (answer.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await portalFetch<EngagementItemDto>(
        `/api/v1/engagement-items/${item.id}/responses`,
        { body: { body: answer.trim(), expectedVersion: version } },
      );
      setVersion(updated.version);
      setAnswer('');
      toast({ title: 'Answer sent to your team', tone: 'success' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: FileDto) {
    setError(null);
    try {
      const updated = await portalFetch<EngagementItemDto>(
        `/api/v1/engagement-items/${item.id}/evidence`,
        { body: { fileIds: [file.id], expectedVersion: version } },
      );
      setVersion(updated.version);
      toast({ title: `${file.originalName} attached`, tone: 'success' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error.message}
          {error.correlationId ? (
            <span className="block text-xs">Reference: {error.correlationId}</span>
          ) : null}
        </Alert>
      ) : null}
      {item.can.respond ? (
        <Field
          label={item.kind === 'query' ? 'Your answer' : 'Your reply'}
          hint="Sent to your SimplexD team and the specialist working on this item."
        >
          {({ id, describedBy }) => (
            <div className="space-y-2">
              <Textarea
                id={id}
                aria-describedby={describedBy}
                value={answer}
                maxLength={4000}
                rows={3}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void respond()}
                loading={busy}
                disabled={answer.trim().length === 0}
              >
                Send answer
              </Button>
            </div>
          )}
        </Field>
      ) : null}
      {item.can.attachEvidence ? (
        <div>
          <p className="mb-1 text-sm font-medium">Upload the requested document</p>
          <FileUploader
            purpose="org_document"
            entityType="service_request"
            entityId={serviceRequestId}
            compact
            label="Upload document"
            hint="PDF or image. Files are scanned before the team can open them."
            onUploaded={(file) => void attach(file)}
            refreshOnSettle={false}
          />
        </div>
      ) : null}
    </div>
  );
}

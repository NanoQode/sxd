'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProjectDto, SiteVisitDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  NativeSelect,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch } from '@/lib/partner/api';
import { newOfflineClientId } from '@/lib/partner/offline/types';

/**
 * Ad-hoc visit for an inspector with an active assignment: the reason is
 * required, the visit is flagged unscheduled and staff are notified. The
 * visit is created online (so it has an id); capture then works offline like
 * any other in-progress visit, and staff can reject it until it is reviewed.
 */
export function StartUnscheduledVisit({
  projects,
  online,
}: {
  projects: ProjectDto[];
  online: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [offlineClientId] = useState(() => newOfflineClientId('visit'));
  const start = useMutation({
    mutationFn: () =>
      partnerFetch<SiteVisitDto & { idempotentReplay: boolean }>(
        `/api/v1/projects/${projectId}/site-visits/unscheduled`,
        { body: { reason: reason.trim(), offlineClientId } },
      ),
    onSuccess: (visit) => {
      toast({
        tone: 'success',
        title: 'Unscheduled visit started',
        description:
          'Staff have been notified. Capture your findings; they can reject the visit until it is reviewed.',
      });
      setOpen(false);
      router.push(`/partner/visits/${visit.id}`);
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not start the visit', description: errorMessage(err) }),
  });
  const valid = projectId !== '' && reason.trim().length >= 5;
  return (
    <div>
      <h3 className="text-sm font-medium">Start an unscheduled visit</h3>
      <p className="text-xs text-fg-muted">
        For work on site that nobody scheduled. Needs an active field assignment on the project and
        a reason; the SimplexD team is told and may reject the visit before its findings are
        reviewed.
      </p>
      {!online ? (
        <Alert tone="warning" title="Needs a connection" className="mt-2">
          The visit is created on the server first so it can be reviewed; once started, capture
          works offline.
        </Alert>
      ) : null}
      <Button className="mt-2" variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
        Start unscheduled visit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Start an unscheduled visit"
          description="Say why you are on site. Staff see the reason and are notified immediately."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) start.mutate();
            }}
          >
            <Field label="Project" htmlFor="unsched-project" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  {projects.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.name} · {humanize(pr.kind)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field
              label="Reason"
              htmlFor="unsched-reason"
              required
              hint="At least 5 characters, e.g. 'Called by the site foreman about a cracked lintel'."
            >
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={start.isPending} disabled={!valid}>
                Start visit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

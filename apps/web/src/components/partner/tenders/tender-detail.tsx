'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { AwardOutcomeDto, TenderDetail } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  PageHeader,
  StatusBadge,
  Textarea,
  formatNairaString,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { isApiCode, partnerFetch, useServerNow } from '@/lib/partner/api';
import { openSignedDownload } from '@/lib/partner/upload';
import { DeadlineCountdown, DetailList, DualTime, LoadingBlock, RequestFailed } from '../common';

const TIMELINE_LABELS: Array<[keyof TenderDetail['timeline']['utc'], string]> = [
  ['releaseAt', 'Released'],
  ['siteVisitAt', 'Site visit'],
  ['questionCutoffAt', 'Question cut-off'],
  ['answersPublishedAt', 'Answers published'],
  ['submissionDeadlineAt', 'Submission deadline'],
  ['evaluationCompleteAt', 'Evaluation complete (target)'],
  ['awardTargetAt', 'Award (target)'],
];

function DocumentButton({ fileId, index }: { fileId: string; index: number }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openSignedDownload(fileId, 'inline');
        } catch (err) {
          toast({
            tone: 'danger',
            title: 'Download not available',
            description: errorMessage(err),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download aria-hidden="true" className="h-4 w-4" />
      Document {index + 1}
    </Button>
  );
}

export function TenderDetailView({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { now } = useServerNow();
  const [question, setQuestion] = useState('');
  const tender = useQuery({
    queryKey: ['partner', 'tender', tenderId],
    queryFn: () => partnerFetch<TenderDetail>(`/api/v1/tenders/${tenderId}`),
  });
  const award = useQuery({
    queryKey: ['partner', 'tender', tenderId, 'award'],
    queryFn: () => partnerFetch<AwardOutcomeDto>(`/api/v1/tenders/${tenderId}/award`),
    enabled: tender.data?.status === 'awarded',
    retry: false,
  });
  const respondInvitation = useMutation({
    mutationFn: (decision: 'accept' | 'decline') =>
      partnerFetch(`/api/v1/tenders/${tenderId}/invitations/respond`, { body: { decision } }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Invitation updated' });
      void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'tenders'] });
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not respond', description: errorMessage(err) }),
  });
  const ask = useMutation({
    mutationFn: () =>
      partnerFetch(`/api/v1/tenders/${tenderId}/questions`, {
        body: { question: question.trim() },
      }),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: 'Question sent',
        description: 'Staff answer privately or publish an anonymised answer to every invitee.',
      });
      setQuestion('');
      void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] });
    },
  });
  const respondAward = useMutation({
    mutationFn: (decision: 'accept' | 'decline') =>
      partnerFetch(`/api/v1/tenders/${tenderId}/award/respond`, { body: { decision } }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Award response recorded' });
      void qc.invalidateQueries({ queryKey: ['partner', 'tender', tenderId] });
      void qc.invalidateQueries({ queryKey: ['partner', 'awards'] });
    },
    onError: (err) =>
      toast({
        tone: 'danger',
        title: 'Could not respond to the award',
        description: errorMessage(err),
      }),
  });

  if (tender.isPending) return <LoadingBlock rows={5} label="Loading tender" />;
  if (tender.isError)
    return (
      <RequestFailed error={tender.error} onRetry={() => void tender.refetch()} context="Tender" />
    );
  const t = tender.data;
  const deadline = t.timeline.effectiveSubmissionDeadlineAt;
  const cutoff = t.timeline.utc.questionCutoffAt;
  const cutoffPassed = cutoff ? new Date(cutoff).getTime() <= now.getTime() : false;
  const deadlinePassed = deadline ? new Date(deadline).getTime() <= now.getTime() : false;
  const open = ['published', 'clarifications'].includes(t.status) && !deadlinePassed;
  const declined = t.myInvitation?.status === 'declined';
  const canAsk = open && !cutoffPassed && !declined && t.status !== 'closed';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t.reference}
        title={t.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            {t.sealed ? <Badge tone="info">Sealed bids</Badge> : null}
            {t.myInvitation ? (
              <Badge tone="neutral">Invitation: {humanize(t.myInvitation.status)}</Badge>
            ) : null}
          </span>
        }
        actions={
          <>
            {!declined ? (
              <Link
                href={`/partner/tenders/${t.id}/bid`}
                className="sx-transition inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-fg-on-primary hover:bg-primary-hover"
              >
                {t.myBid ? 'Open my bid' : open ? 'Start a bid' : 'View bid workspace'}
              </Link>
            ) : null}
          </>
        }
      />
      {t.myInvitation?.status === 'invited' || t.myInvitation?.status === 'viewed' ? (
        <Alert tone="info" title="Respond to the invitation">
          <p>
            Accepting signals intent; it does not commit you to submit. Declining hides the bid
            workspace.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => respondInvitation.mutate('accept')}
              loading={respondInvitation.isPending && respondInvitation.variables === 'accept'}
            >
              Accept invitation
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => respondInvitation.mutate('decline')}
              loading={respondInvitation.isPending && respondInvitation.variables === 'decline'}
            >
              Decline
            </Button>
          </div>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {t.descriptionMarkdown ? (
              <div className="whitespace-pre-wrap">{t.descriptionMarkdown}</div>
            ) : (
              <p className="text-fg-muted">No description provided.</p>
            )}
            {t.partnerDisclosure ? (
              <Alert tone="info" title="Disclosure to bidders">
                {t.partnerDisclosure}
              </Alert>
            ) : null}
            <DetailList
              items={[
                {
                  label: 'Evaluation weights',
                  value:
                    Object.entries(t.evaluationWeights)
                      .map(([k, v]) => `${humanize(k)} ${v}`)
                      .join(' · ') || '—',
                },
                { label: 'Current revision', value: `Revision ${t.currentRevision}` },
                {
                  label: 'Bidding window',
                  value:
                    t.timeline.biddingWindowDays !== null
                      ? `${t.timeline.biddingWindowDays} days`
                      : '—',
                },
                { label: 'Display time zone', value: t.displayTimeZone },
              ]}
            />
            <div>
              <h3 className="font-medium">Documents</h3>
              {t.scopeFileIds.length === 0 ? (
                <p className="text-fg-muted">No scope documents attached.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.scopeFileIds.map((id, i) => (
                    <DocumentButton key={id} fileId={id} index={i} />
                  ))}
                </div>
              )}
              <p className="mt-1 text-xs text-fg-muted">
                Downloads use short-lived signed links and are never cached on this device.
              </p>
            </div>
            {t.revisions.length > 0 ? (
              <div>
                <h3 className="font-medium">Addenda</h3>
                <ul className="mt-2 space-y-2">
                  {t.revisions.map((r) => (
                    <li key={r.id} className="rounded-md border border-border p-3">
                      <p className="text-xs text-fg-muted">
                        Revision {r.revision} ·{' '}
                        <DualTime iso={r.createdAt} zone={t.displayTimeZone} />
                      </p>
                      {r.addendumMarkdown ? (
                        <p className="mt-1 whitespace-pre-wrap">{r.addendumMarkdown}</p>
                      ) : null}
                      {r.deadlineExtendedTo ? (
                        <p className="mt-1">
                          Deadline extended to{' '}
                          <DualTime iso={r.deadlineExtendedTo} zone={t.displayTimeZone} />
                        </p>
                      ) : null}
                      {r.reason ? <p className="mt-1 text-fg-muted">Reason: {r.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
            <p className="text-xs text-fg-muted">Shown in {t.displayTimeZone} and UTC.</p>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {open ? (
              <DeadlineCountdown deadlineIso={deadline} />
            ) : deadlinePassed ? (
              <Badge tone="danger">Deadline passed</Badge>
            ) : null}
            <dl className="space-y-2">
              {TIMELINE_LABELS.map(([key, label]) => (
                <div key={key}>
                  <dt className="text-xs uppercase tracking-wide text-fg-muted">{label}</dt>
                  <dd>
                    <DualTime
                      iso={key === 'submissionDeadlineAt' ? deadline : t.timeline.utc[key]}
                      zone={t.displayTimeZone}
                    />
                    {key === 'submissionDeadlineAt' && t.timeline.extensionRevision ? (
                      <span className="text-xs text-fg-muted">
                        Extended in revision {t.timeline.extensionRevision}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Questions and answers</CardTitle>
          <p className="text-xs text-fg-muted">
            You see your own questions and every answer staff publish (anonymised). Other
            bidders&apos; unpublished questions are never shown.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {t.questions.length === 0 ? (
            <p className="text-fg-muted">No questions yet.</p>
          ) : (
            <ul className="space-y-3">
              {t.questions.map((q) => (
                <li key={q.id} className="rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <HelpCircle aria-hidden="true" className="h-3 w-3" />
                    {q.askedByMe ? 'Asked by you' : 'Published question'} ·{' '}
                    <DualTime iso={q.askedAt} zone={t.displayTimeZone} />
                    {q.published ? (
                      <Badge tone="success">Published</Badge>
                    ) : (
                      <Badge tone="neutral">Private</Badge>
                    )}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap font-medium">{q.question}</p>
                  {q.answer ? (
                    <p className="mt-2 whitespace-pre-wrap">{q.answer}</p>
                  ) : (
                    <p className="mt-2 text-fg-muted">Awaiting an answer.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canAsk ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim().length >= 5) ask.mutate();
              }}
            >
              <Field
                label="Ask a clarification question"
                hint={
                  cutoff
                    ? `Questions close at ${new Date(cutoff).toISOString().replace('T', ' ').slice(0, 16)} UTC (checked on the server clock).`
                    : 'No cut-off set.'
                }
                error={ask.isError ? errorMessage(ask.error) : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    value={question}
                    maxLength={4000}
                    minLength={5}
                    required
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" loading={ask.isPending} disabled={question.trim().length < 5}>
                Send question
              </Button>
            </form>
          ) : (
            <p className="text-fg-muted">
              {declined
                ? 'You declined this invitation.'
                : cutoffPassed
                  ? 'The question cut-off has passed.'
                  : 'Questions are closed for this tender.'}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Award</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {t.status !== 'awarded' ? (
            <p className="text-fg-muted">
              {t.status === 'evaluating' || t.status === 'closed'
                ? 'Bids are being evaluated. The decision is shown here only after staff publish it.'
                : 'No award has been published.'}
            </p>
          ) : award.isPending ? (
            <LoadingBlock rows={1} label="Loading award" />
          ) : award.isError ? (
            isApiCode(award.error, 'not_found') ? (
              <p className="text-fg-muted">The award has not been published to bidders yet.</p>
            ) : (
              <RequestFailed error={award.error} context="Award" />
            )
          ) : (
            <div className="space-y-3">
              <p className="flex items-center gap-2">
                <Badge tone={award.data.outcome === 'awarded' ? 'success' : 'neutral'}>
                  {humanize(award.data.outcome)}
                </Badge>
                <span className="text-fg-muted">
                  Published <DualTime iso={award.data.publishedAt} zone={t.displayTimeZone} />
                </span>
              </p>
              {award.data.award ? (
                <DetailList
                  items={[
                    {
                      label: 'Contract value',
                      value: award.data.award.contractValueKobo
                        ? formatNairaString(award.data.award.contractValueKobo)
                        : '—',
                    },
                    { label: 'Award status', value: humanize(award.data.award.status) },
                    { label: 'Notes', value: award.data.award.notes ?? '—' },
                  ]}
                />
              ) : (
                <p className="text-fg-muted">
                  Your bid was not selected. Competitor details are not disclosed.
                </p>
              )}
              {award.data.award?.status === 'published' ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => respondAward.mutate('accept')}
                    loading={respondAward.isPending && respondAward.variables === 'accept'}
                  >
                    Accept award
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => respondAward.mutate('decline')}
                    loading={respondAward.isPending && respondAward.variables === 'decline'}
                  >
                    Decline award
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { BidReadDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { searchOrganizations } from '@/lib/admin/server/customers';
import { tenderWorkspace } from '@/lib/admin/server/tenders';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Money } from '@/components/admin/money';
import { Section, TabLink, TabNav } from '@/components/admin/section';
import { DefinitionList, Mono } from '../../_components/bits';
import { TenderForm } from '../_components/tender-form';
import { TIMELINE_FIELDS } from '../_lib/timeline';
import { InvitePartners } from './_components/invite-partners';
import { ScoreBid } from './_components/score-bid';

export const metadata: Metadata = { title: 'Tender' };
export const dynamic = 'force-dynamic';

const TABS = ['overview', 'invitations', 'questions', 'bids', 'evaluation', 'award'] as const;
type Tab = (typeof TABS)[number];
const OPEN_FOR_QUESTIONS = new Set(['published', 'clarifications']);
const POST_CLOSE = new Set(['closed', 'evaluating', 'awarded']);

function isOpened(b: BidReadDto): boolean {
  return b.sealed === false;
}

export default async function TenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requireSignedIn('/admin/tenders');
  const { id } = await params;
  const raw = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(raw.tab ?? '')
    ? (raw.tab as Tab)
    : 'overview';
  const loaded = await attempt(() => tenderWorkspace(identity, id));
  if (!loaded.ok) {
    if (loaded.code === 'not_found' || loaded.code === 'validation_failed') notFound();
    return <LoadError code={loaded.code} message={loaded.message} what="This tender" />;
  }
  const w = loaded.value;
  const t = w.tender;
  const perms = w.permissions;
  const orgs = await attempt(() => searchOrganizations(identity, undefined, 500));
  const organizations = orgs.ok ? orgs.value : [];
  const bids = w.bids.ok ? w.bids.value : [];
  const received = bids.filter((b) => b.submittedAt && b.status !== 'withdrawn');
  const anySealed = bids.some((b) => b.sealed);
  const deadline = t.timeline.effectiveSubmissionDeadlineAt;
  const href = (next: Tab) => `/admin/tenders/${t.id}${next === 'overview' ? '' : `?tab=${next}`}`;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/tenders" className="underline">
            Tenders
          </Link>
        }
        title={`${t.reference} · ${t.title}`}
        description={`${w.organizationName}${w.projectName ? ` · ${w.projectName}` : ''} · revision ${t.currentRevision}`}
        actions={
          <>
            <StatusBadge
              status={
                t.status === 'evaluating'
                  ? 'in_review'
                  : t.status === 'awarded'
                    ? 'completed'
                    : t.status
              }
              label={humanize(t.status)}
            />
            {t.sealed ? <Badge tone="gold">sealed bids</Badge> : <Badge>unsealed</Badge>}
            {perms.manage && t.status === 'draft' ? (
              <>
                <TenderForm
                  organizations={organizations}
                  tender={t}
                  trigger="Edit draft"
                  variant="secondary"
                />
                <ApiAction
                  path={`/api/v1/tenders/${t.id}/publish`}
                  body={{ expectedVersion: t.version }}
                  label="Publish"
                  variant="primary"
                  confirm={{
                    title: `Publish ${t.reference}?`,
                    description:
                      'Invited partners can see it and ask questions. After publication, changes become numbered revisions and deadlines can only move later.',
                    confirmLabel: 'Publish tender',
                  }}
                  successMessage="Tender published"
                />
              </>
            ) : null}
            {perms.manage && OPEN_FOR_QUESTIONS.has(t.status) ? (
              <ApiAction
                path={`/api/v1/tenders/${t.id}/close`}
                body={{ expectedVersion: t.version }}
                label="Close bidding"
                confirm={{
                  title: 'Close bidding now?',
                  description:
                    'The server refuses while the submission deadline has not passed. Bids can be opened only after closing.',
                  confirmLabel: 'Close',
                }}
                successMessage="Tender closed"
              />
            ) : null}
            {perms.manage && !['awarded', 'cancelled'].includes(t.status) ? (
              <ApiAction
                path={`/api/v1/tenders/${t.id}/cancel`}
                body={{ expectedVersion: t.version }}
                reasonKey="reason"
                label="Cancel tender"
                variant="ghost"
                confirm={{
                  title: 'Cancel this tender?',
                  description: 'Invitees are told; records are kept.',
                  requireReason: true,
                  confirmLabel: 'Cancel tender',
                  tone: 'danger',
                }}
                successMessage="Tender cancelled"
              />
            ) : null}
          </>
        }
      />
      <TabNav label="Tender sections">
        <TabLink href={href('overview')} active={tab === 'overview'}>
          Overview
        </TabLink>
        <TabLink href={href('invitations')} active={tab === 'invitations'}>
          Invitations ({t.invitations.length})
        </TabLink>
        <TabLink href={href('questions')} active={tab === 'questions'}>
          Q&amp;A ({t.questions.length})
        </TabLink>
        <TabLink href={href('bids')} active={tab === 'bids'}>
          Bids ({t.bidCount ?? received.length})
        </TabLink>
        <TabLink href={href('evaluation')} active={tab === 'evaluation'}>
          Evaluation
        </TabLink>
        <TabLink href={href('award')} active={tab === 'award'}>
          Award
        </TabLink>
      </TabNav>

      {tab === 'overview' ? (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-6">
            <Section title="Scope">
              {t.descriptionMarkdown ? (
                <div className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">
                  {t.descriptionMarkdown}
                </div>
              ) : (
                <p className="text-fg-muted">No scope text.</p>
              )}
              {t.partnerDisclosure ? (
                <Alert tone="info" title="Disclosed relationships (shown to every invitee)">
                  {t.partnerDisclosure}
                </Alert>
              ) : null}
              <DefinitionList
                items={[
                  {
                    term: 'Evaluation weights',
                    value: Object.entries(t.evaluationWeights)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · '),
                  },
                ]}
              />
            </Section>
            <Section
              title={`Revisions and addenda (${t.revisions.length})`}
              description="Append-only. A deadline extension can only move the deadline later."
              actions={
                perms.manage && OPEN_FOR_QUESTIONS.has(t.status) ? (
                  <FormDialog
                    trigger="Issue addendum / extend deadline"
                    title="Revise the published tender"
                    description="Every invitee sees the addendum. Enter a new deadline only to extend it."
                    path={`/api/v1/tenders/${t.id}/revisions`}
                    successMessage="Revision issued"
                    extraBody={{ expectedVersion: t.version }}
                    fields={[
                      { name: 'reason', label: 'Reason', required: true, wide: true },
                      {
                        name: 'addendumMarkdown',
                        label: 'Addendum (markdown)',
                        type: 'textarea',
                        emptyAs: 'null',
                      },
                      {
                        name: 'deadlineExtendedTo',
                        label: 'New submission deadline (your device time)',
                        type: 'datetime',
                        emptyAs: 'null',
                      },
                    ]}
                  />
                ) : perms.manage && t.status === 'awarded' ? (
                  <FormDialog
                    trigger="Record variation"
                    title="Post-award variation"
                    path={`/api/v1/tenders/${t.id}/variations`}
                    successMessage="Variation recorded"
                    fields={[
                      { name: 'reason', label: 'Reason', required: true, wide: true },
                      {
                        name: 'addendumMarkdown',
                        label: 'Details (markdown)',
                        type: 'textarea',
                        emptyAs: 'null',
                      },
                    ]}
                  />
                ) : undefined
              }
            >
              {t.revisions.length === 0 ? (
                <p className="text-fg-muted">No revisions.</p>
              ) : (
                <ol className="space-y-2">
                  {t.revisions.map((r) => (
                    <li key={r.id} className="rounded-md border border-border p-2">
                      <p className="font-medium">
                        Revision {r.revision}{' '}
                        <span className="text-xs text-fg-muted">
                          {formatDateTimeLabel(r.createdAt)}
                        </span>
                      </p>
                      {r.reason ? <p className="text-sm">{r.reason}</p> : null}
                      {r.deadlineExtendedTo ? (
                        <p className="text-sm text-warning">
                          Deadline extended to{' '}
                          {formatDateTimeLabel(r.deadlineExtendedTo, t.displayTimeZone)}
                        </p>
                      ) : null}
                      {r.addendumMarkdown ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">
                          {r.addendumMarkdown}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
          <div className="space-y-6">
            <Section title={`Timeline (${t.displayTimeZone})`}>
              <DefinitionList
                items={TIMELINE_FIELDS.map((f) => ({
                  term: f.label,
                  value: t.timeline.display[f.key] ?? null,
                }))}
              />
              {deadline ? (
                <p className="text-xs text-fg-muted">
                  Effective deadline {formatDateTimeLabel(deadline, t.displayTimeZone)}
                  {t.timeline.extensionRevision
                    ? ` (extended in revision ${t.timeline.extensionRevision}; original ${formatDateTimeLabel(t.timeline.originalSubmissionDeadlineAt!, t.displayTimeZone)})`
                    : ''}
                  {t.timeline.biddingWindowDays !== null
                    ? ` · bidding window ${t.timeline.biddingWindowDays} days`
                    : ''}
                  .
                </p>
              ) : null}
            </Section>
            <Section title="Record">
              <DefinitionList
                items={[
                  {
                    term: 'Organisation',
                    value: (
                      <Link href={`/admin/customers/${t.organizationId}`} className="underline">
                        {w.organizationName}
                      </Link>
                    ),
                  },
                  {
                    term: 'Project',
                    value: t.projectId ? (
                      <Link href={`/admin/projects/${t.projectId}`} className="underline">
                        {w.projectName ?? 'project'}
                      </Link>
                    ) : null,
                  },
                  { term: 'Created by', value: w.createdByName },
                  { term: 'Closed', value: t.closedAt ? formatDateTimeLabel(t.closedAt) : null },
                  { term: 'Cancelled because', value: t.cancelledReason },
                  { term: 'Version', value: t.version },
                ]}
              />
            </Section>
          </div>
        </div>
      ) : null}

      {tab === 'invitations' ? (
        <Section
          title="Invitations"
          description="Partners see a tender only when invited and only their own invitation and bid."
        >
          <DataTable
            caption="Invitations"
            rows={t.invitations}
            rowKey={(i) => i.id}
            rowLabel={(i) => i.partnerName ?? i.partnerUserId}
            emptyMessage="Nobody is invited yet."
            columns={[
              { key: 'p', header: 'Partner', cell: (i) => i.partnerName ?? i.partnerUserId },
              { key: 's', header: 'Status', cell: (i) => humanize(i.status) },
              { key: 'inv', header: 'Invited', cell: (i) => formatDateTimeLabel(i.invitedAt) },
              {
                key: 'v',
                header: 'Viewed',
                cell: (i) => (i.viewedAt ? formatDateTimeLabel(i.viewedAt) : '—'),
                hideOnMobile: true,
              },
              {
                key: 'r',
                header: 'Responded',
                cell: (i) => (i.respondedAt ? formatDateTimeLabel(i.respondedAt) : '—'),
                hideOnMobile: true,
              },
            ]}
          />
          {perms.manage && !['awarded', 'cancelled', 'closed', 'evaluating'].includes(t.status) ? (
            <InvitePartners
              tenderId={t.id}
              partners={w.partners}
              invitedIds={t.invitations.map((i) => i.partnerUserId)}
            />
          ) : null}
        </Section>
      ) : null}

      {tab === 'questions' ? (
        <Section
          title="Clarification questions"
          description="Answers can be published to every invitee; published questions are anonymised. Only staff see who asked."
        >
          {t.questions.length === 0 ? <p className="text-fg-muted">No questions asked.</p> : null}
          <ul className="space-y-3">
            {t.questions.map((q) => (
              <li key={q.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                  <span>
                    Asked {formatDateTimeLabel(q.askedAt)} by{' '}
                    {q.askedByUserId ? (w.askerNames[q.askedByUserId] ?? 'a partner') : 'a partner'}
                  </span>
                  {q.published ? (
                    <Badge tone="success">published to all invitees</Badge>
                  ) : q.answer ? (
                    <Badge tone="warning">answered privately</Badge>
                  ) : (
                    <Badge tone="info">unanswered</Badge>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap font-medium">{q.question}</p>
                {q.answer ? (
                  <p className="mt-2 whitespace-pre-wrap rounded-md bg-bg-sunken p-2 text-sm">
                    {q.answer}
                  </p>
                ) : null}
                {perms.manage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!q.answer ? (
                      <FormDialog
                        trigger="Answer"
                        title="Answer the question"
                        path={`/api/v1/tenders/${t.id}/questions/${q.id}/answer`}
                        successMessage="Answer saved"
                        fields={[
                          { name: 'answer', label: 'Answer', type: 'textarea', required: true },
                          {
                            name: 'publish',
                            label: 'Publish to every invitee now (anonymised)',
                            type: 'checkbox',
                            defaultValue: true,
                          },
                        ]}
                      />
                    ) : null}
                    {q.answer && !q.published ? (
                      <ApiAction
                        path={`/api/v1/tenders/${t.id}/questions/${q.id}/publish`}
                        label="Publish answer"
                        confirm={{
                          title: 'Publish to every invitee?',
                          description: 'The question is shown without the asker.',
                          confirmLabel: 'Publish',
                        }}
                        successMessage="Answer published"
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {tab === 'bids' ? (
        <Section
          title="Bids"
          description="While sealed, everyone (staff included) sees only who submitted and when. Opening is explicit, audited and needs bids.open_sealed with a verified authenticator."
        >
          {!w.bids.ok ? (
            <LoadError code={w.bids.code} message={w.bids.message} what="Bids" />
          ) : null}
          {anySealed ? (
            <Alert
              tone="info"
              title={`Sealed: ${received.length} submission${received.length === 1 ? '' : 's'} received`}
            >
              Amounts and documents stay hidden until the bids are opened after closing.
              {POST_CLOSE.has(t.status) && perms.openSealed
                ? null
                : t.status === 'published' || t.status === 'clarifications'
                  ? ' Bidding is still open.'
                  : ''}
            </Alert>
          ) : null}
          {anySealed && POST_CLOSE.has(t.status) && perms.openSealed ? (
            <div className="flex flex-wrap items-center gap-2">
              {!perms.mfaVerified ? (
                <Alert tone="warning" title="Authenticator required">
                  <Link href="/admin/security/mfa" className="underline">
                    Verify multi-factor authentication
                  </Link>{' '}
                  before opening sealed bids.
                </Alert>
              ) : null}
              <ApiAction
                path={`/api/v1/tenders/${t.id}/open-bids`}
                reasonKey="reason"
                label="Open sealed bids"
                variant="primary"
                confirm={{
                  title: 'Open the sealed bids?',
                  description:
                    'This is recorded in the audit log with your reason and cannot be undone. Starting evaluation also opens them.',
                  requireReason: true,
                  reasonLabel: 'Reason for opening (at least 5 characters, audited)',
                  confirmLabel: 'Open bids',
                }}
                successMessage="Bids opened"
              />
            </div>
          ) : null}
          <DataTable
            caption="Bids"
            rows={bids}
            rowKey={(b) => b.id ?? `${b.partnerUserId}`}
            rowLabel={(b) => b.partnerName ?? b.partnerUserId}
            emptyMessage="No bids yet."
            columns={[
              { key: 'p', header: 'Partner', cell: (b) => b.partnerName ?? b.partnerUserId },
              { key: 's', header: 'Status', cell: (b) => humanize(b.status) },
              {
                key: 'sub',
                header: 'Submitted',
                cell: (b) =>
                  b.submittedAt ? formatDateTimeLabel(b.submittedAt, t.displayTimeZone) : '—',
              },
              {
                key: 'amt',
                header: 'Amount',
                cell: (b) =>
                  isOpened(b) && 'latestRevision' in b && b.latestRevision ? (
                    <Money
                      kobo={b.latestRevision.amountKobo}
                      currency={b.latestRevision.currency}
                    />
                  ) : (
                    <Badge tone="gold">sealed</Badge>
                  ),
              },
              {
                key: 'dur',
                header: 'Duration',
                cell: (b) =>
                  isOpened(b) && 'latestRevision' in b && b.latestRevision?.durationDays
                    ? `${b.latestRevision.durationDays} days`
                    : '—',
                hideOnMobile: true,
              },
              {
                key: 'open',
                header: 'Opened',
                cell: (b) => (b.openedAt ? formatDateTimeLabel(b.openedAt) : '—'),
                hideOnMobile: true,
              },
              {
                key: 'act',
                header: 'Actions',
                cell: (b) =>
                  b.id &&
                  perms.evaluate &&
                  isOpened(b) &&
                  ['submitted', 'evaluated'].includes(b.status) ? (
                    <ApiAction
                      path={`/api/v1/bids/${b.id}/disqualify`}
                      reasonKey="reason"
                      label="Disqualify"
                      variant="ghost"
                      confirm={{
                        title: 'Disqualify this bid?',
                        requireReason: true,
                        confirmLabel: 'Disqualify',
                        tone: 'danger',
                      }}
                      successMessage="Bid disqualified"
                    />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </Section>
      ) : null}

      {tab === 'evaluation' ? (
        <Section
          title="Evaluation matrix"
          description="Each evaluator scores each opened bid 0–100 per criterion; the weighted score and rank average across evaluators."
          actions={
            perms.evaluate && t.status === 'closed' ? (
              <ApiAction
                path={`/api/v1/tenders/${t.id}/evaluate`}
                body={{ expectedVersion: t.version }}
                reasonKey="reason"
                label="Start evaluation (opens sealed bids)"
                variant="primary"
                confirm={{
                  title: 'Start evaluation?',
                  description:
                    'Opens any sealed bids (needs bids.open_sealed and your authenticator) and moves the tender to evaluating.',
                  requireReason: true,
                  reasonLabel: 'Reason (audited, at least 5 characters)',
                  confirmLabel: 'Start evaluation',
                }}
                successMessage="Evaluation started"
              />
            ) : undefined
          }
        >
          {!w.comparison.ok ? (
            !POST_CLOSE.has(t.status) ||
            w.comparison.code === 'invalid_transition' ||
            w.comparison.code === 'not_found' ? (
              <p className="text-fg-muted">
                The comparison is available once bidding has closed and the sealed bids are opened
                (server: {w.comparison.message}).
              </p>
            ) : (
              <LoadError
                code={w.comparison.code}
                message={w.comparison.message}
                what="The evaluation matrix"
              />
            )
          ) : w.comparison.value.bids.length === 0 ? (
            <p className="text-fg-muted">No opened bids to compare yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Bid comparison with weighted scores</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-fg-muted">
                    <th scope="col" className="py-2 pr-2">
                      Rank
                    </th>
                    <th scope="col" className="py-2 pr-2">
                      Partner
                    </th>
                    <th scope="col" className="py-2 pr-2">
                      Amount
                    </th>
                    <th scope="col" className="py-2 pr-2">
                      Duration
                    </th>
                    {w.comparison.value.criteria.map((c) => (
                      <th key={c} scope="col" className="py-2 pr-2">
                        {c} ({w.comparison.ok ? w.comparison.value.evaluationWeights[c] : ''})
                      </th>
                    ))}
                    <th scope="col" className="py-2 pr-2">
                      Weighted (avg)
                    </th>
                    <th scope="col" className="py-2">
                      Score
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {w.comparison.value.bids.map((b) => {
                    const mine =
                      b.evaluations.find((e) => e.evaluatorUserId === identity.session!.user.id) ??
                      null;
                    return (
                      <tr key={b.bidId} className="border-b border-border align-top">
                        <td className="py-2 pr-2">{b.rank ?? '—'}</td>
                        <td className="py-2 pr-2">
                          {b.partnerName ?? b.partnerUserId}
                          <span className="block text-xs text-fg-muted">{humanize(b.status)}</span>
                        </td>
                        <td className="py-2 pr-2">
                          <Money kobo={b.amountKobo} currency={b.currency ?? 'NGN'} />
                        </td>
                        <td className="py-2 pr-2">
                          {b.durationDays ? `${b.durationDays} d` : '—'}
                        </td>
                        {w.comparison.ok
                          ? w.comparison.value.criteria.map((c) => {
                              const vals = b.evaluations
                                .map((e) => e.scores[c])
                                .filter((v): v is number => typeof v === 'number');
                              return (
                                <td key={c} className="py-2 pr-2">
                                  {vals.length
                                    ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)
                                    : '—'}
                                </td>
                              );
                            })
                          : null}
                        <td className="py-2 pr-2 font-medium">
                          {b.averageWeightedScore ?? '—'}
                          <span className="block text-xs text-fg-muted">
                            {b.evaluatorCount} evaluator{b.evaluatorCount === 1 ? '' : 's'}
                          </span>
                        </td>
                        <td className="py-2">
                          {perms.evaluate &&
                          t.status === 'evaluating' &&
                          b.status !== 'disqualified' &&
                          w.comparison.ok ? (
                            <ScoreBid
                              bidId={b.bidId}
                              label={b.partnerName ?? 'bid'}
                              criteria={w.comparison.value.criteria}
                              weights={w.comparison.value.evaluationWeights}
                              existing={mine?.scores ?? null}
                            />
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {tab === 'award' ? (
        <Section
          title="Award"
          description="Decide on one bid while evaluating, then publish. Partners learn the outcome only when it is published; losing bidders see only that they were unsuccessful."
        >
          {w.award ? (
            <DefinitionList
              items={[
                { term: 'Winning partner', value: w.award.partnerName ?? w.award.partnerUserId },
                {
                  term: 'Contract value',
                  value: <Money kobo={w.award.contractValueKobo} currency={w.award.currency} />,
                },
                { term: 'Status', value: humanize(w.award.status) },
                { term: 'Decided', value: formatDateTimeLabel(w.award.decidedAt) },
                {
                  term: 'Published',
                  value: w.award.publishedAt ? formatDateTimeLabel(w.award.publishedAt) : 'not yet',
                },
                {
                  term: 'Winner responded',
                  value: w.award.respondedAt ? formatDateTimeLabel(w.award.respondedAt) : null,
                },
                { term: 'Notes', value: w.award.notes },
              ]}
            />
          ) : (
            <p className="text-fg-muted">No award decided.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {perms.manage && t.status === 'evaluating' && !w.award && w.comparison.ok ? (
              <FormDialog
                trigger="Decide award"
                title="Decide the award"
                description="Recorded as decided; nobody outside staff sees it until published."
                path={`/api/v1/tenders/${t.id}/award`}
                variant="primary"
                successMessage="Award decided"
                extraBody={{ expectedVersion: t.version }}
                fields={[
                  {
                    name: 'bidId',
                    label: 'Winning bid',
                    type: 'select',
                    required: true,
                    options: w.comparison.value.bids
                      .filter((b) => b.status !== 'disqualified')
                      .map((b) => ({
                        value: b.bidId,
                        label: `${b.rank ? `#${b.rank} ` : ''}${b.partnerName ?? b.partnerUserId} · score ${b.averageWeightedScore ?? 'unscored'}`,
                      })),
                  },
                  { name: 'notes', label: 'Decision notes', type: 'textarea', emptyAs: 'null' },
                ]}
              />
            ) : null}
            {perms.manage && w.award?.status === 'decided' ? (
              <ApiAction
                path={`/api/v1/tenders/${t.id}/award/publish`}
                body={{ expectedVersion: t.version }}
                label="Publish award"
                variant="primary"
                confirm={{
                  title: 'Publish the award?',
                  description:
                    'The winner is notified and can accept; other bidders are told they were unsuccessful.',
                  confirmLabel: 'Publish',
                }}
                successMessage="Award published"
              />
            ) : null}
          </div>
          {received.length > 0 ? (
            <p className="text-xs text-fg-muted">
              <Mono>{received.length}</Mono> submitted bid{received.length === 1 ? '' : 's'} on
              record.
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

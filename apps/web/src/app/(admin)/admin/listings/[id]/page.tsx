import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ApiError,
  VERIFICATION_CHECK_LABELS,
  uuidSchema,
  verificationCheckItemSchema,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  DataTable,
  PageHeader,
  StatusBadge,
  formatArea,
  formatDateLabel,
  formatDateTimeLabel,
  formatNairaString,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, can, requireAnyStaff } from '@/lib/admin/server/context';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { Section } from '@/components/admin/section';
import { availabilityLabel, priceLabel, tenureLabel } from '@/components/public/listing-labels';
import { listListingInquiries } from '@/server/listings/moderation';
import { listOffersForListing } from '@/server/listings/offers';
import { getListingDetail } from '@/server/listings/owner';
import { getListingTransaction } from '@/server/listings/transactions';
import { DefinitionList } from '../../_components/bits';

export const metadata: Metadata = { title: 'Listing' };
export const dynamic = 'force-dynamic';

export default async function AdminListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn('/admin/listings');
  requireAnyStaff(identity, ['content.publish', 'rentals.manage', 'customers.read']);
  const listing = await getListingDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!listing) notFound();
  const [offers, inquiries, transaction] = await Promise.all([
    attempt(() => listOffersForListing(identity, id)),
    can(identity, 'leads.read')
      ? attempt(() => listListingInquiries(identity, id))
      : Promise.resolve(null),
    attempt(() => getListingTransaction(identity, id)),
  ]);
  const canModerate = can(identity, 'content.publish');
  const canVerify = can(identity, 'rentals.manage');
  const rev = listing.current;
  const pub = listing.published;
  const inModeration = listing.status === 'in_moderation';
  const authorityOk = listing.ownerAuthority?.effectiveStatus === 'verified';
  const decisionBody = { expectedVersion: listing.version };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/listings" className="underline">
            Listings
          </Link>
        }
        title={listing.title}
        description={`${humanize(listing.kind)} · ${listing.propertyName ?? 'property'} · ${listing.organizationName ?? listing.organizationId} · revision ${listing.currentVersion}${listing.publishedVersion !== null ? ` (published v${listing.publishedVersion})` : ''}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={listing.effectiveStatus} />
            {listing.duplicateOfListingId ? (
              <Badge tone="warning">
                duplicate{listing.duplicateOfSlug ? ` of ${listing.duplicateOfSlug}` : ''}
              </Badge>
            ) : null}
            {listing.publishedVersion !== null &&
            listing.effectiveStatus !== 'expired' &&
            ['published', 'in_moderation'].includes(listing.status) ? (
              <Link href={`/properties/${listing.slug}`} className="text-sm underline">
                Public page
              </Link>
            ) : null}
          </span>
        }
      />
      {listing.moderationNote ? (
        <Alert tone="info" title="Last moderation note">
          {listing.moderationNote}
        </Alert>
      ) : null}
      {inModeration && !authorityOk ? (
        <Alert tone="danger" title="Owner authority is not verified">
          Publication is refused until a verified, unexpired authority exists for the property.
          Verify it from the property page (rentals.manage).
        </Alert>
      ) : null}
      {inModeration && rev.publicLocationPrecision === 'exact' ? (
        <Alert tone="warning" title="Exact coordinates requested">
          This revision asks to publish the property coordinates. Approving requires the explicit
          &ldquo;approve exact location&rdquo; confirmation; otherwise request changes.
        </Alert>
      ) : null}

      <Section
        title="Decision"
        description={
          canModerate
            ? inModeration
              ? `Approving publishes revision ${listing.currentVersion} for 90 days. ${listing.publishedVersion !== null ? 'Rejecting or requesting changes keeps the live revision and returns the listing to published.' : ''}`
              : 'Only listings in moderation take decisions. Duplicate marking also applies to live listings.'
            : 'Moderation decisions need content.publish.'
        }
      >
        {canModerate ? (
          <div className="flex flex-wrap gap-2">
            <FormDialog
              trigger="Approve and publish"
              title={`Publish revision ${listing.currentVersion}?`}
              description="Re-checks the owner authority, records it on the verification scope, starts the 90-day availability window and notifies the owner."
              path={`/api/v1/admin/listings/${id}/approve`}
              extraBody={{ ...decisionBody, revisionVersion: listing.currentVersion }}
              fields={[
                {
                  name: 'approveExactLocation',
                  label: 'Approve publishing exact coordinates',
                  type: 'checkbox',
                  hint:
                    rev.publicLocationPrecision === 'exact'
                      ? 'required for this revision'
                      : 'not requested by this revision',
                },
                {
                  name: 'note',
                  label: 'Note to the owner (optional)',
                  type: 'textarea',
                  emptyAs: 'null',
                },
              ]}
              submitLabel="Publish"
              successMessage="Listing published"
              variant="primary"
              disabled={!inModeration || !authorityOk}
              disabledReason={!inModeration ? 'Not in moderation' : 'Owner authority not verified'}
            />
            <ApiAction
              path={`/api/v1/admin/listings/${id}/request-changes`}
              label="Request changes"
              body={decisionBody}
              reasonKey="reason"
              confirm={{
                title: 'Request changes?',
                description: 'The owner receives the reason and resubmits an edited revision.',
                requireReason: true,
                confirmLabel: 'Send',
              }}
              successMessage="Changes requested"
              disabled={!inModeration}
              disabledReason="Not in moderation"
            />
            <ApiAction
              path={`/api/v1/admin/listings/${id}/reject`}
              label="Reject"
              variant="danger"
              body={decisionBody}
              reasonKey="reason"
              confirm={{
                title: 'Reject this submission?',
                description: 'The reason is recorded and sent to the owner.',
                requireReason: true,
                confirmLabel: 'Reject',
                tone: 'danger',
              }}
              successMessage="Listing rejected"
              disabled={!inModeration}
              disabledReason="Not in moderation"
            />
            <FormDialog
              trigger="Mark as duplicate"
              title="Mark as a duplicate"
              description="The listing leaves the public site, cannot be resubmitted and its URL points to the original while that is live."
              path={`/api/v1/admin/listings/${id}/mark-duplicate`}
              extraBody={decisionBody}
              fields={[
                {
                  name: 'duplicateOfListingId',
                  label: 'Original listing id',
                  required: true,
                  hint: 'The id of the listing this one duplicates.',
                },
                { name: 'reason', label: 'Reason', type: 'textarea', required: true },
              ]}
              submitLabel="Mark duplicate"
              successMessage="Marked as duplicate"
              variant="ghost"
              disabled={
                Boolean(listing.duplicateOfListingId) ||
                !['in_moderation', 'published', 'paused', 'expired'].includes(
                  listing.effectiveStatus,
                )
              }
              disabledReason="Not applicable in this status"
            />
          </div>
        ) : null}
      </Section>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Section
            title={`Revision ${rev.version} under review`}
            description={
              pub && pub.version !== rev.version
                ? `Published revision ${pub.version} differs; fields that changed are marked.`
                : undefined
            }
          >
            <DefinitionList
              items={[
                { term: 'Title', value: diff(rev.title, pub?.title) },
                { term: 'Price', value: diff(priceLabel(rev), pub ? priceLabel(pub) : undefined) },
                {
                  term: 'Area',
                  value: diff(formatArea(rev.areaM2), pub ? formatArea(pub.areaM2) : undefined),
                },
                {
                  term: 'Tenure',
                  value: diff(tenureLabel(rev.tenure), pub ? tenureLabel(pub.tenure) : undefined),
                },
                {
                  term: 'Availability',
                  value: diff(
                    availabilityLabel(rev.availability),
                    pub ? availabilityLabel(pub.availability) : undefined,
                  ),
                },
                {
                  term: 'Public location precision',
                  value: diff(
                    humanize(rev.publicLocationPrecision),
                    pub ? humanize(pub.publicLocationPrecision) : undefined,
                  ),
                },
                {
                  term: 'Title disclosure',
                  value: <span className="whitespace-pre-wrap">{rev.titleDisclosure ?? '—'}</span>,
                },
                {
                  term: 'Description',
                  value: (
                    <span className="whitespace-pre-wrap">{rev.descriptionMarkdown ?? '—'}</span>
                  ),
                },
                { term: 'Slug', value: listing.slug },
              ]}
            />
          </Section>
          <Section
            title={`Media (${listing.media.length})`}
            description="Only images approved for public use are shown publicly. Approval (evidence.approve or content.media.manage) is done per file."
          >
            <DataTable
              caption="Listing media"
              rows={listing.media}
              rowKey={(m) => m.id}
              rowLabel={(m) => m.originalName}
              emptyMessage="No media attached."
              columns={[
                {
                  key: 'name',
                  header: 'File',
                  cell: (m) => (
                    <a
                      href={`/api/v1/files/${m.id}/download?variant=web`}
                      className="underline break-all"
                    >
                      {m.originalName}
                    </a>
                  ),
                },
                {
                  key: 'status',
                  header: 'Scan',
                  cell: (m) => (
                    <StatusBadge
                      status={m.status === 'clean' ? 'verified' : m.status}
                      label={humanize(m.status)}
                    />
                  ),
                },
                {
                  key: 'public',
                  header: 'Public use',
                  cell: (m) =>
                    m.isPublicApproved ? (
                      <Badge tone="success">approved</Badge>
                    ) : (
                      <Badge tone="neutral">not approved</Badge>
                    ),
                },
                {
                  key: 'alt',
                  header: 'Alt text',
                  cell: (m) => m.altText ?? '—',
                  hideOnMobile: true,
                },
              ]}
            />
          </Section>
          <Section
            title="Verification scope"
            description="What was checked, by whom, when and until when. Shown publicly; never rewritten, only appended."
            actions={
              canVerify ? (
                <FormDialog
                  trigger="Record a check"
                  title="Record a verification check"
                  description="Appended to the current revision and to the published one when it differs."
                  path={`/api/v1/admin/listings/${id}/verification-checks`}
                  fields={[
                    {
                      name: 'item',
                      label: 'What was checked',
                      type: 'select',
                      required: true,
                      options: verificationCheckItemSchema.options.map((v) => ({
                        value: v,
                        label: VERIFICATION_CHECK_LABELS[v],
                      })),
                    },
                    {
                      name: 'outcome',
                      label: 'Outcome',
                      type: 'select',
                      required: true,
                      options: [
                        { value: 'passed', label: 'Passed' },
                        { value: 'issue_found', label: 'Issue found' },
                        { value: 'inconclusive', label: 'Inconclusive' },
                      ],
                    },
                    {
                      name: 'result',
                      label: 'What was found (public wording)',
                      type: 'textarea',
                      required: true,
                    },
                    {
                      name: 'checkedAt',
                      label: 'Checked at',
                      type: 'datetime',
                      hint: 'Defaults to now.',
                    },
                    { name: 'expiresAt', label: 'Valid until', type: 'datetime', emptyAs: 'null' },
                    {
                      name: 'summary',
                      label: 'Scope summary (replaces the current one)',
                      type: 'textarea',
                    },
                  ]}
                  submitLabel="Record"
                  successMessage="Check recorded"
                />
              ) : undefined
            }
          >
            {rev.verification.summary ? (
              <p className="mb-2 text-sm">{rev.verification.summary}</p>
            ) : null}
            <DataTable
              caption="Verification checks"
              rows={rev.verification.checks}
              rowKey={(c) => `${c.item}-${c.checkedAt}`}
              rowLabel={(c) => c.label}
              emptyMessage="No checks recorded. Publication still records the owner-authority check automatically."
              columns={[
                { key: 'item', header: 'Check', cell: (c) => c.label },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (c) => (c.outcome ? humanize(c.outcome) : '—'),
                },
                { key: 'result', header: 'Found', cell: (c) => c.result },
                { key: 'by', header: 'By', cell: (c) => c.checkedBy, hideOnMobile: true },
                { key: 'at', header: 'When', cell: (c) => formatDateLabel(c.checkedAt) },
                {
                  key: 'exp',
                  header: 'Until',
                  cell: (c) => (c.expiresAt ? formatDateLabel(c.expiresAt) : '—'),
                },
              ]}
            />
          </Section>
          <Section
            title={`Offers (${offers.ok ? offers.value.length : '?'})`}
            description="Staff follow negotiations; only the parties decide."
          >
            {offers.ok ? (
              <DataTable
                caption="Offers"
                rows={offers.value}
                rowKey={(o) => o.id}
                rowLabel={(o) => o.id}
                emptyMessage="No offers."
                columns={[
                  { key: 'amount', header: 'Amount', cell: (o) => formatNairaString(o.amountKobo) },
                  {
                    key: 'buyer',
                    header: 'Buyer',
                    cell: (o) => o.buyerOrganizationName ?? o.buyerOrganizationId,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (o) => <StatusBadge status={o.effectiveStatus} />,
                  },
                  {
                    key: 'entries',
                    header: 'Steps',
                    cell: (o) => o.negotiationLog.length,
                    hideOnMobile: true,
                  },
                  {
                    key: 'updated',
                    header: 'Updated',
                    cell: (o) => formatDateTimeLabel(o.updatedAt),
                    hideOnMobile: true,
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-fg-muted">{offers.message}</p>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="Owner authority">
            {listing.ownerAuthority ? (
              <DefinitionList
                items={[
                  { term: 'Owner', value: listing.ownerAuthority.ownerName },
                  {
                    term: 'Status',
                    value: <StatusBadge status={listing.ownerAuthority.effectiveStatus} />,
                  },
                  {
                    term: 'Verified',
                    value: listing.ownerAuthority.verifiedAt
                      ? formatDateTimeLabel(listing.ownerAuthority.verifiedAt)
                      : null,
                  },
                  {
                    term: 'Expires',
                    value: listing.ownerAuthority.expiresAt
                      ? formatDateTimeLabel(listing.ownerAuthority.expiresAt)
                      : 'No expiry',
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-fg-muted">No authority submitted.</p>
            )}
            <Link
              href={`/admin/properties/${listing.propertyId}`}
              className="mt-2 inline-block text-sm underline"
            >
              Property record and authority documents
            </Link>
          </Section>
          <Section title="Publication">
            <DefinitionList
              items={[
                {
                  term: 'Published',
                  value: listing.publishedAt ? formatDateTimeLabel(listing.publishedAt) : null,
                },
                {
                  term: 'Shown until',
                  value: listing.expiresAt ? formatDateTimeLabel(listing.expiresAt) : null,
                },
                {
                  term: 'Availability confirmed',
                  value: listing.availabilityConfirmedAt
                    ? formatDateTimeLabel(listing.availabilityConfirmedAt)
                    : null,
                },
                { term: 'Published by', value: listing.publishedBy },
                { term: 'Moderated by', value: listing.moderatedBy },
                { term: 'Listing version', value: listing.version },
              ]}
            />
          </Section>
          <Section
            title={`Inquiries${inquiries?.ok ? ` (${inquiries.value.length})` : ''}`}
            description="Qualified in CRM; the owner sees only the count."
          >
            {inquiries === null ? (
              <p className="text-sm text-fg-muted">Needs leads.read.</p>
            ) : !inquiries.ok ? (
              <p className="text-sm text-fg-muted">{inquiries.message}</p>
            ) : inquiries.value.length === 0 ? (
              <p className="text-sm text-fg-muted">No inquiries yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {inquiries.value.map((l) => (
                  <li key={l.id} className="flex flex-wrap justify-between gap-2">
                    <Link href={`/admin/leads/${l.id}`} className="underline">
                      {l.contactName}
                    </Link>
                    <span className="flex items-center gap-2">
                      {l.suspicious ? <Badge tone="warning">flagged</Badge> : null}
                      <StatusBadge status={l.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section
            title="Transaction"
            description="Milestones and outcome recorded on the land sales/leasing request."
          >
            {transaction.ok ? (
              <div className="space-y-2 text-sm">
                <p>
                  Request:{' '}
                  {transaction.value.serviceRequest ? (
                    <Link
                      href={`/admin/service-requests/${transaction.value.serviceRequest.id}`}
                      className="underline"
                    >
                      {transaction.value.serviceRequest.reference}
                    </Link>
                  ) : (
                    'not linked'
                  )}
                </p>
                <p>
                  {transaction.value.milestones.length} milestone
                  {transaction.value.milestones.length === 1 ? '' : 's'};{' '}
                  {transaction.value.outcome
                    ? `outcome ${transaction.value.outcome.outcome} (${transaction.value.outcome.fileIds.length} evidence files)`
                    : 'no outcome recorded'}
                  .
                </p>
                {transaction.value.acceptedOffer ? (
                  <p>
                    Accepted offer: {formatNairaString(transaction.value.acceptedOffer.amountKobo)}.
                  </p>
                ) : null}
                <Link href={`/portal/listings/${id}?tab=transaction`} className="underline">
                  Open the transaction panel
                </Link>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{transaction.message}</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function diff(current: string, published: string | undefined) {
  if (published === undefined || published === current) return current;
  return (
    <span>
      {current} <Badge tone="info">changed</Badge>{' '}
      <span className="text-fg-muted">(published: {published})</span>
    </span>
  );
}

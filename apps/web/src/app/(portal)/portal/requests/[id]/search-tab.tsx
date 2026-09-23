import Link from 'next/link';
import type { ShortlistComparisonDto, ShortlistDto, ShortlistItemDto } from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  formatDateTimeLabel,
  humanize,
} from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import { koboToNaira } from '@/lib/portal/format';
import { capabilityNote, type CustomerCapabilities } from '@/lib/portal/server/permissions';
import { LinkButton } from '@/components/portal/link-button';
import {
  AcceptShortlistButton,
  LinkViewingAppointment,
  RequestViewingButton,
  ShortlistFeedback,
  ViewingFeedbackForm,
} from '@/components/portal/search-purchase';
import { getSearchWorkspace } from '@/server/search/shortlists';

/**
 * Customer view of the property-search workspace: the shortlists the team
 * shared with a side-by-side comparison (only what the listing disclosed or
 * what staff recorded, each labelled with its source), ratings and feedback,
 * viewings with post-viewing feedback, and acceptance.
 */

const ROWS: Array<{ key: keyof ShortlistComparisonDto; label: string }> = [
  { key: 'price', label: 'Price' },
  { key: 'priceBasis', label: 'Price basis' },
  { key: 'area', label: 'Area (m²)' },
  { key: 'tenure', label: 'Tenure' },
  { key: 'titleDisclosure', label: 'Title disclosure' },
  { key: 'verification', label: 'Verification scope' },
  { key: 'location', label: 'Location' },
  { key: 'locationPrecision', label: 'Location precision' },
  { key: 'availability', label: 'Availability' },
];

const SOURCE_LABEL = {
  listing: 'from the published listing',
  shortlist_entry: 'as stated by the source',
};

function cellText(item: ShortlistItemDto, key: keyof ShortlistComparisonDto): string {
  const v = item.comparison[key];
  if (v.value === null) return 'Not disclosed';
  if (key === 'verification') {
    const ver = item.comparison.verification.value!;
    const checks = ver.checks.map((c) => humanize(c.item)).join(', ');
    return checks || ver.summary || 'Not disclosed';
  }
  if (key === 'price') return koboToNaira(v.value as string, { whole: true });
  return humanize(String(v.value));
}

export function ComparisonTable({ items }: { items: ShortlistItemDto[] }) {
  const live = items.filter((i) => i.status !== 'removed');
  if (live.length === 0) return <p className="text-sm text-fg-muted">No entries yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <caption className="sr-only">Side-by-side comparison of shortlisted properties</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Attribute
            </th>
            {live.map((i) => (
              <th key={i.id} scope="col" className="px-2 py-2 text-left align-top font-medium">
                {i.listingSlug && i.listingPublished ? (
                  <Link href={`/properties/${i.listingSlug}`} className="text-primary underline">
                    {i.title}
                  </Link>
                ) : (
                  i.title
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusBadge status={i.status} />
                  {i.externalReference ? <Badge tone="neutral">External</Badge> : null}
                  {i.listingId && i.listingPublished === false ? (
                    <Badge tone="warning">No longer published</Badge>
                  ) : null}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <th
                scope="row"
                className="px-2 py-2 text-left align-top text-xs font-medium text-fg-muted"
              >
                {row.label}
              </th>
              {live.map((i) => {
                const source = i.comparison[row.key].source;
                return (
                  <td key={i.id} className="px-2 py-2 align-top">
                    <span className={source ? '' : 'text-fg-muted'}>{cellText(i, row.key)}</span>
                    {source ? (
                      <span className="block text-xs text-fg-subtle">{SOURCE_LABEL[source]}</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-border">
            <th
              scope="row"
              className="px-2 py-2 text-left align-top text-xs font-medium text-fg-muted"
            >
              Source reference
            </th>
            {live.map((i) => (
              <td key={i.id} className="px-2 py-2 align-top text-xs text-fg-muted">
                {i.externalReference ?? (i.listingId ? 'SimplexD listing' : '—')}
                {i.notes ? <span className="block">Team note: {i.notes}</span> : null}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ShortlistCard({
  shortlist,
  serviceRequestId,
  caps,
  zone,
  closed,
}: {
  shortlist: ShortlistDto;
  serviceRequestId: string;
  caps: CustomerCapabilities;
  zone: string;
  closed: boolean;
}) {
  const frozen =
    shortlist.status === 'accepted' || shortlist.status === 'outcome_recorded' || closed;
  const live = shortlist.items.filter((i) => i.status !== 'removed');
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{shortlist.name}</CardTitle>
            <CardDescription>
              {live.length} {live.length === 1 ? 'entry' : 'entries'} · shared{' '}
              {formatDateTimeLabel(shortlist.updatedAt, zone)}
            </CardDescription>
          </div>
          <StatusBadge status={shortlist.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {shortlist.acceptance ? (
          <Alert tone="success" title="Shortlist accepted">
            Accepted {formatDateTimeLabel(shortlist.acceptance.acceptedAt, zone)}
            {shortlist.acceptance.acceptedByName
              ? ` by ${shortlist.acceptance.acceptedByName}`
              : ''}
            .
          </Alert>
        ) : null}
        {shortlist.status === 'outcome_recorded' ? (
          shortlist.outcome ? (
            <Alert tone="info" title={`Search outcome: ${humanize(shortlist.outcome.outcome)}`}>
              {shortlist.outcome.summary}{' '}
              {shortlist.outcome.reportId ? (
                <Link
                  href={`/portal/reports/${shortlist.outcome.reportId}`}
                  className="font-medium underline"
                >
                  Read the outcome report
                </Link>
              ) : null}
            </Alert>
          ) : (
            <Alert tone="info" title="Search outcome recorded">
              The team documented the outcome of this search. The summary appears here once a
              reviewer releases it.
            </Alert>
          )
        ) : null}
        <ComparisonTable items={shortlist.items} />
        {live.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {live.map((i) => (
              <li key={i.id} className="space-y-2 rounded-md border border-border p-3">
                <p className="font-medium">{i.title}</p>
                <ShortlistFeedback
                  itemId={i.id}
                  rating={i.customerRating}
                  feedback={i.customerFeedback}
                  status={i.status}
                  readOnly={frozen || !caps.can('org.comment')}
                />
                {!frozen ? (
                  i.listingId ? (
                    ['viewing_requested', 'viewed'].includes(i.status) ? (
                      <p className="text-xs text-fg-muted">
                        {i.status === 'viewed' ? 'Viewed' : 'Viewing requested'}
                      </p>
                    ) : (
                      <RequestViewingButton
                        serviceRequestId={serviceRequestId}
                        shortlistItemId={i.id}
                        disabledReason={
                          caps.manageAppointments
                            ? undefined
                            : capabilityNote(caps, 'Requesting a viewing')
                        }
                      />
                    )
                  ) : (
                    <p className="text-xs text-fg-muted">
                      External property:{' '}
                      <Link
                        href={`/portal/appointments/new?request=${serviceRequestId}&kind=viewing`}
                        className="underline"
                      >
                        book a viewing appointment
                      </Link>{' '}
                      and record it below.
                    </p>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {shortlist.status === 'shared' && !closed ? (
          <div className="border-t border-border pt-3">
            <AcceptShortlistButton
              shortlistId={shortlist.id}
              expectedUpdatedAt={shortlist.updatedAt}
              canAccept={caps.acceptQuotes}
              cannotAcceptReason={capabilityNote(caps, 'Accepting the shortlist')}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export async function SearchTab({
  identity,
  requestId,
  caps,
  zone,
  closed,
}: {
  identity: RequestIdentity;
  requestId: string;
  caps: CustomerCapabilities;
  zone: string;
  closed: boolean;
}) {
  const ws = await getSearchWorkspace(identity, requestId);
  return (
    <section aria-label="Property search" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          Save your own search criteria and get alerted when a matching listing is published.
        </p>
        <LinkButton href="/portal/searches" variant="secondary" size="sm">
          Saved searches and alerts
        </LinkButton>
      </div>
      {ws.shortlists.length === 0 ? (
        <EmptyState
          title="No shortlist shared yet"
          description="Your project manager builds a shortlist from published listings and properties found through agents, then shares it here for you to compare, rate and request viewings."
        />
      ) : (
        ws.shortlists.map((s) => (
          <ShortlistCard
            key={s.id}
            shortlist={s}
            serviceRequestId={requestId}
            caps={caps}
            zone={zone}
            closed={closed}
          />
        ))
      )}
      <Card>
        <CardHeader>
          <CardTitle>Viewings</CardTitle>
          <CardDescription>
            Viewings the team is arranging or has completed. Tell us how each one went.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!closed && caps.manageAppointments ? (
            <LinkViewingAppointment
              serviceRequestId={requestId}
              appointments={ws.unlinkedViewingAppointments}
            />
          ) : null}
          {ws.viewings.length === 0 ? (
            <p className="text-sm text-fg-muted">No viewings yet.</p>
          ) : (
            <ul className="space-y-3">
              {ws.viewings.map((v) => (
                <li key={v.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{v.title}</span>
                    <StatusBadge status={v.status} />
                  </div>
                  <p className="text-xs text-fg-muted">
                    {v.scheduledAt
                      ? formatDateTimeLabel(v.scheduledAt, zone)
                      : 'Time to be confirmed'}
                    {v.appointmentId ? (
                      <>
                        {' · '}
                        <Link
                          href={`/portal/appointments/${v.appointmentId}`}
                          className="underline"
                        >
                          appointment
                        </Link>
                      </>
                    ) : null}
                  </p>
                  {v.status === 'completed' && !closed && caps.can('org.comment') ? (
                    <div className="mt-2">
                      <ViewingFeedbackForm
                        viewingId={v.id}
                        expectedUpdatedAt={v.updatedAt}
                        existing={v.feedback}
                      />
                    </div>
                  ) : v.feedback ? (
                    <p className="mt-1 text-xs text-fg-muted">“{v.feedback}”</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

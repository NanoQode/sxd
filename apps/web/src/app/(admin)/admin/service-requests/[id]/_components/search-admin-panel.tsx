import Link from 'next/link';
import type { SearchListingDto, ShortlistDto } from '@simplexd/contracts';
import { Badge, StatusBadge, formatDateTimeLabel, humanize } from '@simplexd/ui';
import type { RequestIdentity } from '@/lib/auth/session';
import { attempt } from '@/lib/admin/server/context';
import { koboToNaira } from '@/lib/portal/format';
import { ApiAction } from '@/components/admin/api-action';
import { FormDialog } from '@/components/admin/form-dialog';
import { LoadError } from '@/components/admin/load-error';
import { Section } from '@/components/admin/section';
import { ComparisonTable } from '@/app/(portal)/portal/requests/[id]/search-tab';
import { searchPublishedListings } from '@/server/search/saved-searches';
import { getSearchWorkspace } from '@/server/search/shortlists';

/**
 * Staff side of the property-search workspace: build shortlists from
 * published listings or external references (source reference required,
 * price optional), share them, run viewings and document the outcome.
 */

const OUTCOME_OPTIONS = [
  { value: 'property_selected', label: 'A property was selected' },
  { value: 'proceeding_to_purchase', label: 'Proceeding to purchase representation' },
  { value: 'no_suitable_property', label: 'No suitable property found' },
  { value: 'customer_paused_search', label: 'Customer paused the search' },
  { value: 'purchased_elsewhere', label: 'Customer purchased elsewhere' },
];

function ShortlistControls({
  shortlist,
  listings,
  canManage,
}: {
  shortlist: ShortlistDto;
  listings: SearchListingDto[];
  canManage: boolean;
}) {
  const frozen = shortlist.status === 'accepted' || shortlist.status === 'outcome_recorded';
  if (!canManage || frozen) return null;
  const path = `/api/v1/shortlists/${shortlist.id}`;
  return (
    <div className="flex flex-wrap gap-2">
      <FormDialog
        trigger="Add a published listing"
        title="Add a published listing"
        description="Facts are read from the published revision; nothing is copied or estimated."
        path={`${path}/items`}
        submitLabel="Add"
        successMessage="Listing added"
        fields={[
          {
            name: 'listingId',
            label: 'Listing',
            type: 'select',
            required: true,
            options: listings.map((l) => ({
              value: l.id,
              label: `${l.title}${l.marketName ? ` · ${l.marketName}` : ''}${l.priceKobo ? ` · ${koboToNaira(l.priceKobo, { whole: true })}` : ' · price not disclosed'}`,
            })),
            wide: true,
          },
          { name: 'notes', label: 'Note for the customer', type: 'textarea', wide: true },
        ]}
      />
      <FormDialog
        trigger="Add an external reference"
        title="Add a property found outside SimplexD"
        description="Record where it came from. Enter the asking price only as the source stated it; leave it blank when not disclosed."
        path={`${path}/items`}
        submitLabel="Add"
        successMessage="Entry added"
        fields={[
          { name: 'title', label: 'Title', required: true, wide: true },
          {
            name: 'externalReference',
            label: 'Source reference',
            required: true,
            hint: 'Agent, portal URL or reference number.',
            wide: true,
          },
          { name: 'priceKobo', label: 'Asking price (₦)', type: 'naira', hint: 'Optional.' },
          { name: 'notes', label: 'Note for the customer', type: 'textarea', wide: true },
        ]}
      />
      {shortlist.status === 'draft' ? (
        <ApiAction
          path={path}
          method="PATCH"
          body={{ status: 'shared', expectedUpdatedAt: shortlist.updatedAt }}
          label="Share with the customer"
          variant="primary"
          successMessage="Shortlist shared"
          disabled={shortlist.items.length === 0}
          disabledReason="Add at least one entry first"
        />
      ) : (
        <FormDialog
          trigger="Record outcome"
          title="Document the search outcome"
          description="Drafts a search-outcome report under this request (a different reviewer releases it to the customer) and freezes the shortlist."
          path={`${path}/outcome`}
          submitLabel="Record"
          successMessage="Outcome recorded"
          extraBody={{ expectedUpdatedAt: shortlist.updatedAt }}
          fields={[
            { name: 'outcome', label: 'Outcome', type: 'select', required: true, options: OUTCOME_OPTIONS, wide: true },
            { name: 'summary', label: 'Summary for the customer', type: 'textarea', required: true, wide: true },
          ]}
        />
      )}
    </div>
  );
}

export async function SearchAdminPanel({
  identity,
  requestId,
  canManage,
}: {
  identity: RequestIdentity;
  requestId: string;
  canManage: boolean;
}) {
  const ws = await attempt(() => getSearchWorkspace(identity, requestId));
  const listings = ws.ok ? await searchPublishedListings(identity, { limit: 50 }).catch(() => []) : [];
  return (
    <Section
      id="property-search"
      title="Shortlist and viewings"
      description="Build the shortlist from published listings or external references, share it, run viewings and document the outcome. The customer compares, rates and requests viewings from their request page."
      actions={
        ws.ok && canManage ? (
          <FormDialog
            trigger="New shortlist"
            title="Start a shortlist"
            path={`/api/v1/service-requests/${requestId}/shortlists`}
            submitLabel="Create"
            successMessage="Shortlist created"
            fields={[{ name: 'name', label: 'Name', required: true, wide: true }]}
          />
        ) : null
      }
    >
      {!ws.ok ? (
        <LoadError code={ws.code} message={ws.message} what="Shortlists" />
      ) : (
        <div className="space-y-6">
          {ws.value.shortlists.length === 0 ? (
            <p className="text-fg-muted">No shortlist yet.</p>
          ) : (
            ws.value.shortlists.map((s) => (
              <div key={s.id} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-fg-muted">
                      {s.items.length} entries · updated {formatDateTimeLabel(s.updatedAt)}
                      {s.acceptance ? ` · accepted by ${s.acceptance.acceptedByName ?? 'the customer'}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={s.status} />
                </div>
                {s.outcome ? (
                  <p className="text-xs">
                    Outcome: {humanize(s.outcome.outcome)} —{' '}
                    <Link href={`/admin/reports/${s.outcome.reportId}`} className="underline">
                      review the outcome report
                    </Link>
                  </p>
                ) : null}
                <ComparisonTable items={s.items} />
                {s.items.filter((i) => i.status !== 'removed').length > 0 && canManage ? (
                  <ul className="space-y-1 text-xs">
                    {s.items
                      .filter((i) => i.status !== 'removed')
                      .map((i) => (
                        <li key={i.id} className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{i.title}</span>
                          <StatusBadge status={i.status} />
                          {i.customerRating ? <Badge tone="info">Rated {i.customerRating}/5</Badge> : null}
                          {i.customerFeedback ? <span className="text-fg-muted">“{i.customerFeedback}”</span> : null}
                          {s.status === 'draft' || s.status === 'shared' ? (
                            <FormDialog
                              trigger="Edit"
                              title={`Edit “${i.title}”`}
                              path={`/api/v1/shortlist-items/${i.id}`}
                              method="PATCH"
                              submitLabel="Save"
                              size="sm"
                              variant="ghost"
                              fields={[
                                { name: 'notes', label: 'Note for the customer', type: 'textarea', defaultValue: i.notes ?? '', wide: true },
                                {
                                  name: 'status',
                                  label: 'Status',
                                  type: 'select',
                                  defaultValue: i.status,
                                  options: ['candidate', 'preferred', 'viewing_requested', 'viewed', 'rejected', 'removed'].map((v) => ({ value: v, label: humanize(v) })),
                                },
                                { name: 'sortOrder', label: 'Order', type: 'number', defaultValue: i.sortOrder },
                                ...(i.listingId
                                  ? []
                                  : [
                                      { name: 'title', label: 'Title', defaultValue: i.title, wide: true },
                                      { name: 'externalReference', label: 'Source reference', defaultValue: i.externalReference ?? '', wide: true },
                                      { name: 'priceKobo', label: 'Asking price (₦)', type: 'naira' as const, hint: 'Leave blank when not disclosed.' },
                                    ]),
                              ]}
                            />
                          ) : null}
                        </li>
                      ))}
                  </ul>
                ) : null}
                <ShortlistControls shortlist={s} listings={listings} canManage={canManage} />
              </div>
            ))
          )}

          <div className="space-y-2">
            <p className="font-medium">Viewings</p>
            {ws.value.viewings.length === 0 ? (
              <p className="text-fg-muted">
                No viewings yet. External properties are viewed through a booked viewing appointment (
                <Link href={`/admin/appointments/book?serviceRequestId=${requestId}`} className="underline">
                  book one
                </Link>
                ) which the customer or you then record as a viewing.
              </p>
            ) : (
              <ul className="space-y-2">
                {ws.value.viewings.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                    <span className="font-medium">{v.title}</span>
                    <StatusBadge status={v.status} />
                    <span className="text-xs text-fg-muted">
                      {v.scheduledAt ? formatDateTimeLabel(v.scheduledAt) : 'unscheduled'}
                      {v.requestedByName ? ` · requested by ${v.requestedByName}` : ''}
                    </span>
                    {v.feedback ? <span className="text-xs text-fg-muted">Customer: “{v.feedback}”</span> : null}
                    {canManage && (v.status === 'requested' || v.status === 'confirmed') ? (
                      <>
                        <FormDialog
                          trigger={v.status === 'requested' ? 'Confirm' : 'Reschedule'}
                          title="Schedule the viewing"
                          path={`/api/v1/viewings/${v.id}`}
                          method="PATCH"
                          size="sm"
                          submitLabel="Save"
                          extraBody={{ expectedUpdatedAt: v.updatedAt, ...(v.status === 'requested' ? { status: 'confirmed' } : {}) }}
                          fields={[
                            { name: 'scheduledAt', label: 'Scheduled at', type: 'datetime', required: true, wide: true },
                            ...(ws.value.unlinkedViewingAppointments.length > 0
                              ? [
                                  {
                                    name: 'appointmentId',
                                    label: 'Link a booked viewing appointment',
                                    type: 'select' as const,
                                    options: [
                                      { value: '', label: 'None' },
                                      ...ws.value.unlinkedViewingAppointments.map((a) => ({
                                        value: a.id,
                                        label: `${formatDateTimeLabel(a.startsAt)} (${humanize(a.status)})`,
                                      })),
                                    ],
                                    wide: true,
                                  },
                                ]
                              : []),
                          ]}
                        />
                        <ApiAction
                          path={`/api/v1/viewings/${v.id}`}
                          method="PATCH"
                          body={{ status: 'completed', expectedUpdatedAt: v.updatedAt }}
                          label="Mark completed"
                          successMessage="Viewing completed"
                        />
                        <ApiAction
                          path={`/api/v1/viewings/${v.id}`}
                          method="PATCH"
                          body={{ status: 'no_show', expectedUpdatedAt: v.updatedAt }}
                          label="No show"
                          confirm={{ title: 'Record a no-show', confirmLabel: 'Record' }}
                        />
                        <ApiAction
                          path={`/api/v1/viewings/${v.id}`}
                          method="PATCH"
                          body={{ status: 'cancelled', expectedUpdatedAt: v.updatedAt }}
                          label="Cancel"
                          confirm={{ title: 'Cancel this viewing', confirmLabel: 'Cancel viewing', tone: 'danger' }}
                        />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage && ws.value.unlinkedViewingAppointments.length > 0 ? (
              <ApiAction
                path={`/api/v1/service-requests/${requestId}/viewings`}
                body={{ appointmentId: ws.value.unlinkedViewingAppointments[0]!.id }}
                label={`Record the booked viewing of ${formatDateTimeLabel(ws.value.unlinkedViewingAppointments[0]!.startsAt)}`}
                successMessage="Viewing recorded"
              />
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}

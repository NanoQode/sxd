import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  PageHeader,
  humanize,
} from '@simplexd/ui';

export interface AvailabilityRow {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timeZone: string;
  kinds: string[] | null;
  active: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Read-only availability. The schema has `staff_availability` and the
 * permission `partner.availability.manage` exists, but no API route reads or
 * writes those rows for partners yet, so editing is deliberately absent and
 * the reason is stated on the page rather than behind a dead button.
 */
export function AvailabilityView({
  rows,
  profileStatus,
  isPartner,
}: {
  rows: AvailabilityRow[];
  profileStatus: string | null;
  isPartner: boolean;
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Availability"
        description="When staff may book you for visits and appointments. Times are stored per weekday in the zone shown."
      />
      {isPartner ? (
        <Card>
          <CardHeader>
            <CardTitle>Profile status</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Badge
              tone={
                profileStatus === 'available'
                  ? 'success'
                  : profileStatus === 'unavailable'
                    ? 'danger'
                    : 'neutral'
              }
            >
              {humanize(profileStatus ?? 'unknown')}
            </Badge>
            <p className="mt-2 text-fg-muted">
              Set by staff on your partner profile when they verify you. Tell your SimplexD contact
              if it is wrong.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Weekly hours</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <DataTable
            caption="Weekly availability"
            rows={rows}
            rowKey={(r) => r.id}
            rowLabel={(r) => WEEKDAYS[r.weekday] ?? `Day ${r.weekday}`}
            emptyMessage="No availability windows are recorded for you."
            columns={[
              {
                key: 'day',
                header: 'Weekday',
                cell: (r) => WEEKDAYS[r.weekday] ?? `Day ${r.weekday}`,
              },
              { key: 'from', header: 'From', cell: (r) => r.startTime.slice(0, 5) },
              { key: 'to', header: 'To', cell: (r) => r.endTime.slice(0, 5) },
              { key: 'zone', header: 'Zone', cell: (r) => r.timeZone },
              {
                key: 'kinds',
                header: 'For',
                cell: (r) =>
                  r.kinds && r.kinds.length > 0 ? r.kinds.map(humanize).join(', ') : 'Any',
              },
              { key: 'active', header: 'Active', cell: (r) => (r.active ? 'Yes' : 'No') },
            ]}
          />
          <Alert tone="info" title="Editing is not available yet">
            The permission <code className="font-mono">partner.availability.manage</code> and the{' '}
            <code className="font-mono">staff_availability</code> table exist, but there is no API
            endpoint that lets a partner read or change their own windows. Until it is added, ask
            your SimplexD contact to update your hours; nothing here pretends to save.
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

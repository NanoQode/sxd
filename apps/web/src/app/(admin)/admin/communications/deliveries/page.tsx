import type { Metadata } from 'next';
import Link from 'next/link';
import { DateTime } from 'luxon';
import { deliveryLogQuerySchema, type DeliveryLogQuery } from '@simplexd/contracts';
import { PageHeader, buttonVariants } from '@simplexd/ui';
import {
  FilterBar,
  FilterCheckbox,
  FilterInput,
  FilterSelect,
} from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { attempt } from '@/lib/admin/server/context';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { deliveryLog, listTemplateCatalog } from '@/server/admin/communications/service';
import { CHANNEL_LABELS, DELIVERY_STATUS_LABELS } from '../_lib/labels';
import { DeliveryLogTable } from './delivery-log-table';

export const metadata: Metadata = { title: 'Delivery log' };
export const dynamic = 'force-dynamic';

const PATH = '/admin/communications/deliveries';
const STATUSES = [
  'queued',
  'accepted',
  'sent',
  'delivered',
  'failed',
  'suppressed',
  'bounced',
  'rejected',
] as const;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

/** `YYYY-MM-DD` in Africa/Lagos → ISO instant at the start (or end) of that day. */
function dayBound(day: string | undefined, end: boolean): string | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const dt = DateTime.fromISO(day, { zone: 'Africa/Lagos' });
  if (!dt.isValid) return undefined;
  return (end ? dt.endOf('day') : dt.startOf('day')).toUTC().toISO() ?? undefined;
}

/**
 * Delivery log: every attempt with a masked recipient, real provider status
 * (accepted is not delivered), the status timeline, sanitised failure
 * reasons, provider ids, and an idempotent retry for failed attempts.
 */
export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireSignedIn(PATH);
  const ctx = adminContext(identity);
  const sp = await searchParams;
  const raw = {
    channel: first(sp['channel']),
    status: first(sp['status']),
    templateKey: first(sp['templateKey']),
    recipient: first(sp['recipient']),
    testOnly: first(sp['testOnly']) ? 'true' : undefined,
    developmentOnly: first(sp['developmentOnly']) ? 'true' : undefined,
    from: dayBound(first(sp['from']), false),
    to: dayBound(first(sp['to']), true),
    cursor: first(sp['cursor']),
    limit: 25,
  };
  const parsed = deliveryLogQuerySchema.safeParse(raw);
  const query: DeliveryLogQuery = parsed.success
    ? parsed.data
    : { limit: 25, testOnly: false, developmentOnly: false };

  const header = (
    <PageHeader
      title="Delivery log"
      description="Every email, SMS and in-app attempt. Recipients are masked; the recipient filter needs the exact address or user id. “Accepted” is the provider taking the message — only a receipt or bounce changes delivery status."
    />
  );
  const loaded = await attempt(() =>
    Promise.all([deliveryLog(ctx, query), listTemplateCatalog(ctx).catch(() => [])]),
  );
  if (!loaded.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError code={loaded.code} message={loaded.message} what="Delivery log" />
      </div>
    );
  }
  const [page, families] = loaded.value;
  const templateKeys = [...new Set(families.map((f) => f.key))].sort();
  const keep: Record<string, string | undefined> = {
    channel: query.channel,
    status: query.status,
    templateKey: query.templateKey,
    recipient: query.recipient,
    testOnly: query.testOnly ? '1' : undefined,
    developmentOnly: query.developmentOnly ? '1' : undefined,
    from: first(sp['from']),
    to: first(sp['to']),
  };
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${PATH}?${s}` : PATH;
  };

  return (
    <div className="space-y-6">
      {header}
      {!parsed.success ? (
        <p className="text-sm text-danger">
          Some filters were ignored: {parsed.error.issues[0]?.message}
        </p>
      ) : null}
      <FilterBar>
        <FilterSelect
          name="channel"
          label="Channel"
          value={query.channel}
          options={(['email', 'sms', 'in_app'] as const).map((c) => ({
            value: c,
            label: CHANNEL_LABELS[c]!,
          }))}
        />
        <FilterSelect
          name="status"
          label="Status"
          value={query.status}
          options={STATUSES.map((s) => ({ value: s, label: DELIVERY_STATUS_LABELS[s]! }))}
        />
        <FilterSelect
          name="templateKey"
          label="Template"
          value={query.templateKey}
          options={templateKeys.map((k) => ({ value: k, label: k }))}
        />
        <FilterInput
          name="recipient"
          label="Recipient (exact) or user id"
          value={query.recipient}
          placeholder="+234… or name@example.com"
        />
        <FilterInput name="from" label="From (date)" value={first(sp['from'])} type="date" />
        <FilterInput name="to" label="To (date)" value={first(sp['to'])} type="date" />
        <FilterCheckbox name="testOnly" label="Test sends only" checked={query.testOnly} />
        <FilterCheckbox
          name="developmentOnly"
          label="Development adapter only"
          checked={query.developmentOnly}
        />
      </FilterBar>
      <DeliveryLogTable items={page.items} />
      {query.cursor || page.nextCursor ? (
        <nav aria-label="Delivery log pages" className="flex flex-wrap justify-between gap-2">
          {query.cursor ? (
            <Link href={qs({})} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              First page
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link
              href={qs({ cursor: page.nextCursor })}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

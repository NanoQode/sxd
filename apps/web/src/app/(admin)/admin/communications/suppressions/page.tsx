import type { Metadata } from 'next';
import Link from 'next/link';
import { suppressionListQuerySchema, type SuppressionListQuery } from '@simplexd/contracts';
import { PageHeader, buttonVariants } from '@simplexd/ui';
import { FilterBar, FilterInput, FilterSelect } from '@/components/admin/filter-bar';
import { LoadError } from '@/components/admin/load-error';
import { attempt } from '@/lib/admin/server/context';
import { requireSignedIn } from '@/lib/auth/session';
import { adminContext } from '@/server/admin/context';
import { suppressionList } from '@/server/admin/communications/service';
import { CHANNEL_LABELS, SUPPRESSION_KIND_LABELS } from '../_lib/labels';
import { BounceImportForm, SuppressionsTable } from './suppressions-table';

export const metadata: Metadata = { title: 'Suppressions' };
export const dynamic = 'force-dynamic';

const PATH = '/admin/communications/suppressions';

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

/**
 * Suppression list: STOP replies, hard bounces and complaints that block a
 * channel for every category. Lifting one needs a reason and is audited;
 * consent recorded by a STOP reply is never overridden here.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requireSignedIn(PATH);
  const ctx = adminContext(identity);
  const sp = await searchParams;
  const parsed = suppressionListQuerySchema.safeParse({
    channel: first(sp['channel']),
    kind: first(sp['kind']),
    address: first(sp['address']),
    cursor: first(sp['cursor']),
    limit: 25,
  });
  const query: SuppressionListQuery = parsed.success ? parsed.data : { limit: 25 };
  const header = (
    <PageHeader
      title="Suppressions"
      description="Addresses that receive nothing on a channel: STOP replies, hard bounces and complaints. Addresses are masked; look one up by its exact email or number."
    />
  );
  const loaded = await attempt(() => suppressionList(ctx, query));
  if (!loaded.ok) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError code={loaded.code} message={loaded.message} what="Suppressions" />
      </div>
    );
  }
  const keep: Record<string, string | undefined> = {
    channel: query.channel,
    kind: query.kind,
    address: query.address,
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
      <FilterBar>
        <FilterSelect
          name="channel"
          label="Channel"
          value={query.channel}
          options={(['email', 'sms'] as const).map((c) => ({ value: c, label: CHANNEL_LABELS[c]! }))}
        />
        <FilterSelect
          name="kind"
          label="Reason"
          value={query.kind}
          options={Object.entries(SUPPRESSION_KIND_LABELS).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <FilterInput
          name="address"
          label="Exact address"
          value={query.address}
          placeholder="+234… or name@example.com"
        />
      </FilterBar>
      <SuppressionsTable items={loaded.value.items} />
      {query.cursor || loaded.value.nextCursor ? (
        <nav aria-label="Suppression pages" className="flex flex-wrap justify-between gap-2">
          {query.cursor ? (
            <Link href={qs({})} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              First page
            </Link>
          ) : (
            <span />
          )}
          {loaded.value.nextCursor ? (
            <Link
              href={qs({ cursor: loaded.value.nextCursor })}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
      <BounceImportForm />
    </div>
  );
}

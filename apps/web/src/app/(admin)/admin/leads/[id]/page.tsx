import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import { getDb, schema, withActor } from '@simplexd/db';
import { authorizeStaff } from '@simplexd/domain/authz';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, formatDateTimeLabel, formatWholeNaira, humanize } from '@simplexd/ui';
import { requireStaffPage } from '@/lib/auth/session';
import { getLeadDetail, listStaffAssignees } from '@/server/leads/admin';
import { LeadActions } from './lead-actions';

export const metadata: Metadata = { title: 'Lead' };
export const dynamic = 'force-dynamic';

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireStaffPage('leads.read');
  const lead = await getLeadDetail(identity, id).catch((err) => {
    if (err instanceof ApiError && err.code === 'not_found') return null;
    throw err;
  });
  if (!lead) notFound();
  const canManage = authorizeStaff(identity.actor, 'leads.manage').allowed;
  const [assignees, services] = await Promise.all([
    listStaffAssignees(identity),
    withActor(getDb(), identity.ctx, (tx) =>
      tx
        .select({ slug: schema.services.slug, name: schema.services.name, category: schema.services.category })
        .from(schema.services)
        .where(eq(schema.services.inquiryEnabled, true))
        .orderBy(asc(schema.services.sortOrder)),
    ),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/admin/leads" className="underline">
            Leads
          </Link>
        }
        title={lead.contactName}
        description={`${lead.email}${lead.phoneE164 ? ` · ${lead.phoneE164}` : ''} · via ${humanize(lead.source)} · received ${formatDateTimeLabel(lead.createdAt)}`}
        actions={<Badge tone="primary">{humanize(lead.status)}</Badge>}
      />
      {lead.suspicious ? (
        <Alert tone="warning" title="Flagged by spam heuristics">
          The honeypot field was filled or the form was submitted unusually fast. Review before contacting.
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Context</CardTitle>
              <CardDescription>Everything the customer supplied; nothing here is re-asked when the lead converts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div>
                  <dt className="text-fg-muted">Goal</dt>
                  <dd>{lead.goal ? humanize(lead.goal) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Service of interest</dt>
                  <dd>{lead.interestServiceName ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Budget</dt>
                  <dd>{lead.budgetNaira !== null ? formatWholeNaira(lead.budgetNaira) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Country / time zone</dt>
                  <dd>
                    {lead.countryOfResidence ?? '—'} / {lead.timeZone ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Markets</dt>
                  <dd>{lead.markets.length > 0 ? lead.markets.map((m) => `${m.name} (${m.stateName})`).join(', ') : '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Scenario</dt>
                  <dd>
                    {lead.scenario ? (
                      <Link href={`/explore?scenario=${lead.scenario.id}`} className="text-primary underline">
                        {lead.scenario.name} ({humanize(lead.scenario.objective)})
                      </Link>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Existing account</dt>
                  <dd>
                    {lead.linkedUser ? (
                      <>
                        {lead.linkedUser.name} ({lead.linkedUser.email}){lead.organizationName ? ` · ${lead.organizationName}` : ''}
                      </>
                    ) : (
                      'No account with this email'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Marketing consent</dt>
                  <dd>{lead.marketingConsent ? 'Granted' : 'Not granted'}</dd>
                </div>
              </dl>
              <div>
                <p className="text-fg-muted">Message</p>
                <p className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3">{lead.message ?? 'No message.'}</p>
              </div>
              {lead.convertedServiceRequestId ? (
                <Alert tone="success" title={`Converted to ${lead.convertedReference ?? 'a service request'}`}>
                  The request was created in inquiry for the customer&apos;s organisation.
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Internal notes</CardTitle>
              <CardDescription>Visible to staff only; never shown to the customer.</CardDescription>
            </CardHeader>
            <CardContent>
              {lead.notes.length === 0 ? (
                <p className="text-sm text-fg-muted">No notes yet.</p>
              ) : (
                <ol className="space-y-2">
                  {lead.notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-border p-3 text-sm">
                      <p className="mb-1 text-xs text-fg-muted">
                        {n.authorName ?? 'Staff'} · {formatDateTimeLabel(n.createdAt)}
                      </p>
                      <p className="whitespace-pre-wrap">{n.body}</p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
        <div>
          <LeadActions lead={lead} assignees={assignees} services={services} canManage={canManage} />
        </div>
      </div>
    </div>
  );
}

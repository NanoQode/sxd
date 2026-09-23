import type { ReactNode } from 'react';
import { requireSignedIn } from '@/lib/auth/session';
import { attempt, requireAnyStaff } from '@/lib/admin/server/context';
import { LoadError } from '@/components/admin/load-error';
import { SectionNav } from '@/components/admin/section-nav';
import { CONFIG_READ_PERMISSIONS } from '@/server/admin/configuration/shared';

export const dynamic = 'force-dynamic';

const NAV = [
  {
    href: '/admin/services',
    label: 'Price anchors',
    exact: true,
    alsoActive: ['/admin/services/pricing/'],
  },
  { href: '/admin/services/quote-templates', label: 'Quote templates' },
  { href: '/admin/services/report-templates', label: 'Report templates' },
  { href: '/admin/services/document-requirements', label: 'Document requirements' },
  { href: '/admin/services/sla-policies', label: 'SLA policies' },
];

/**
 * Service configuration: price anchors with reviewed publication, quotation
 * and report templates, document requirements and SLA targets. Readable by
 * any configuration reader; every page and mutation checks its own
 * permission on the server.
 */
export default async function ServicesLayout({ children }: { children: ReactNode }) {
  const identity = await requireSignedIn('/admin/services');
  const allowed = await attempt(async () => requireAnyStaff(identity, CONFIG_READ_PERMISSIONS));
  if (!allowed.ok)
    return <LoadError code={allowed.code} message={allowed.message} what="Service configuration" />;
  return (
    <div className="space-y-6">
      <SectionNav items={NAV} label="Service configuration sections" />
      {children}
    </div>
  );
}

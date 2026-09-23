import type { Metadata } from 'next';
import { LOCAL_DEFAULT } from '@/components/public/defaults';
import { AudiencePage } from '../_lib/audience-page';
import { contentBySlug, publicMetadata } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'For owners and professionals in Nigeria',
  description:
    'Scheduled visits with captured evidence, reconciled statements and delegated approvals for busy owners and professionals in Nigeria who cannot be on site.',
  path: '/local-nigeria',
});

export default async function LocalNigeriaPage() {
  const cms = await contentBySlug('local-nigeria', 'page');
  return (
    <AudiencePage
      path="/local-nigeria"
      copy={LOCAL_DEFAULT}
      cms={cms}
      illustration="evidence-report"
      goalHref="/explore?objective=owner_occupation"
    />
  );
}

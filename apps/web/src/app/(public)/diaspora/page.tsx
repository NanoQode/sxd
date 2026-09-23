import type { Metadata } from 'next';
import { DIASPORA_DEFAULT } from '@/components/public/defaults';
import { AudiencePage } from '../_lib/audience-page';
import { contentBySlug, publicMetadata } from '../_lib/site-data';

export const metadata: Metadata = publicMetadata({
  title: 'For Nigerians abroad',
  description:
    'Time-zone-aware coordination, evidence digests and delegated approvals for Nigerians who own or build property at home while living abroad.',
  path: '/diaspora',
});

export default async function DiasporaPage() {
  const cms = await contentBySlug('diaspora', 'page');
  return (
    <AudiencePage
      path="/diaspora"
      copy={DIASPORA_DEFAULT}
      cms={cms}
      illustration="coordination"
      goalHref="/explore?objective=long_term_rent"
    />
  );
}

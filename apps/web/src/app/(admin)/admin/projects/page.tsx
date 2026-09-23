import type { Metadata } from 'next';
import { requireSignedIn } from '@/lib/auth/session';
import { PlannedSection } from '../_components/planned-section';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  await requireSignedIn('/admin/projects');
  return <PlannedSection sectionKey="projects" />;
}

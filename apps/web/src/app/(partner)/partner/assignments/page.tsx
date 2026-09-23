import type { Metadata } from 'next';
import { AssignmentInbox } from '@/components/partner/assignments/assignment-inbox';

export const metadata: Metadata = { title: 'Assignments' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <AssignmentInbox />;
}

import type { Metadata } from 'next';
import { ConversationsList } from '@/components/partner/messages/conversations';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

export default function Page() {
  return <ConversationsList />;
}

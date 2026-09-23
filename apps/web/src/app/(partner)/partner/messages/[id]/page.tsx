import type { Metadata } from 'next';
import { ConversationView } from '@/components/partner/messages/conversations';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConversationView conversationId={id} />;
}

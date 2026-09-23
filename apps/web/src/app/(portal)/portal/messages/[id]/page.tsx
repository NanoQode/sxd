import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, uuidSchema } from '@simplexd/contracts';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  humanize,
} from '@simplexd/ui';
import { requireSignedIn } from '@/lib/auth/session';
import { capabilityNote, customerCapabilities } from '@/lib/portal/server/permissions';
import { ConversationThread } from '@/components/portal/conversation-thread';
import { getConversation } from '@/server/conversations/service';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const identity = await requireSignedIn(`/portal/messages/${id}`);
  const conversation = await getConversation(identity, id).catch((err) => {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'forbidden'))
      return null;
    throw err;
  });
  if (!conversation) notFound();
  const zone = identity.profile?.timeZone ?? 'Africa/Lagos';
  const caps = customerCapabilities(
    identity,
    conversation.organizationId ?? identity.ctx.organizationId,
  );
  const canSend = caps.isStaff || caps.sendMessages;
  const entityHref =
    conversation.entityType === 'service_request'
      ? `/portal/requests/${conversation.entityId}`
      : conversation.entityType === 'project'
        ? `/portal/projects/${conversation.entityId}`
        : conversation.entityType === 'property'
          ? `/portal/properties/${conversation.entityId}`
          : null;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/portal/messages" className="underline">
            Messages
          </Link>
        }
        title={conversation.subject}
        description={`${humanize(conversation.kind)} · ${conversation.participants
          .filter((p) => !p.leftAt)
          .map((p) => p.name ?? 'Participant')
          .join(', ')}`}
      />
      <Card>
        <CardHeader>
          <CardTitle>Thread</CardTitle>
          <CardDescription>
            Newest messages at the bottom; press Ctrl/Cmd + Enter to send.
            {entityHref ? (
              <>
                {' '}
                <Link href={entityHref} className="underline">
                  Open the related record
                </Link>
                .
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConversationThread
            conversation={conversation}
            currentUserId={identity.session!.user.id}
            zone={zone}
            canSend={canSend}
            cannotSendReason={capabilityNote(caps, 'Sending messages')}
          />
        </CardContent>
      </Card>
    </div>
  );
}

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  AssignmentDto,
  ConversationDetail,
  InvitedTenderDto,
  Page,
  PartnerConversationEntityType,
  PurchaseOrderDto,
  RfqDto,
} from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Textarea,
  humanize,
  useToast,
} from '@simplexd/ui';
import { errorMessage } from '@/lib/api/client-fetch';
import { partnerFetch, withQuery } from '@/lib/partner/api';
import { usePartner } from '@/lib/partner/context';
import { partnerModules } from '@/lib/partner/nav';

interface Subject {
  key: string;
  entityType: PartnerConversationEntityType;
  entityId: string;
  label: string;
}

/**
 * "Start a conversation" for partners. The subject is one of the partner's
 * own records (an accepted or active assignment, an invited tender, an RFQ
 * or order naming them); the server picks the SimplexD staff on the other
 * side, so no user ids are ever typed here and customers are never added.
 */
export function StartConversation() {
  const p = usePartner();
  const modules = partnerModules(p);
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [subjectKey, setSubjectKey] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');

  const assignments = useQuery({
    queryKey: ['partner', 'assignments', 'all'],
    queryFn: () =>
      partnerFetch<Page<AssignmentDto>>(withQuery('/api/v1/assignments/mine', { limit: 100 })),
    enabled: open,
  });
  const tenders = useQuery({
    queryKey: ['partner', 'tenders', 'mine', 'subjects'],
    queryFn: () =>
      partnerFetch<Page<InvitedTenderDto>>(withQuery('/api/v1/tenders/mine', { limit: 100 })),
    enabled: open && modules.has('tenders'),
  });
  const orders = useQuery({
    queryKey: ['partner', 'orders', 'subjects'],
    queryFn: () =>
      partnerFetch<Page<PurchaseOrderDto>>(withQuery('/api/v1/purchase-orders', { limit: 100 })),
    enabled: open && modules.has('rfqs'),
  });
  const rfqs = useQuery({
    queryKey: ['partner', 'rfqs', 'subjects'],
    queryFn: () => partnerFetch<Page<RfqDto>>(withQuery('/api/v1/rfqs', { limit: 100 })),
    enabled: open && modules.has('rfqs'),
  });

  const subjects: Subject[] = [
    ...(assignments.data?.items ?? [])
      .filter((a) => a.status === 'accepted' || a.status === 'active')
      .map((a): Subject => {
        const entityType: PartnerConversationEntityType = a.projectId
          ? 'project'
          : 'service_request';
        const entityId = a.projectId ?? a.serviceRequestId ?? '';
        return {
          key: `assignment:${a.id}`,
          entityType,
          entityId,
          label: `${humanize(a.role)} assignment · ${a.projectId ? 'project' : 'service request'} ${entityId.slice(0, 8)}`,
        };
      })
      .filter((s) => s.entityId !== ''),
    ...(tenders.data?.items ?? [])
      .filter((t) => t.invitation.status !== 'declined')
      .map((t): Subject => ({
        key: `tender:${t.id}`,
        entityType: 'tender',
        entityId: t.id,
        label: `Tender · ${t.title}`,
      })),
    ...(rfqs.data?.items ?? []).map((r): Subject => ({
      key: `rfq:${r.id}`,
      entityType: 'rfq',
      entityId: r.id,
      label: `RFQ · ${r.title}`,
    })),
    ...(orders.data?.items ?? []).map((o): Subject => ({
      key: `po:${o.id}`,
      entityType: 'purchase_order',
      entityId: o.id,
      label: `Purchase order · ${o.number}`,
    })),
  ];
  // Deduplicate subjects that resolve to the same record (two assignments on one project).
  const uniqueSubjects = subjects.filter(
    (s, i, all) =>
      all.findIndex((x) => x.entityType === s.entityType && x.entityId === s.entityId) === i,
  );
  const selected = uniqueSubjects.find((s) => s.key === subjectKey) ?? uniqueSubjects[0] ?? null;
  const loading =
    assignments.isPending ||
    (modules.has('tenders') && tenders.isPending) ||
    (modules.has('rfqs') && (orders.isPending || rfqs.isPending));

  const start = useMutation({
    mutationFn: () =>
      partnerFetch<ConversationDetail & { staffParticipantUserIds: string[] }>(
        '/api/v1/conversations/partner',
        {
          body: {
            entityType: selected!.entityType,
            entityId: selected!.entityId,
            subject: title.trim(),
            message: message.trim(),
          },
        },
      ),
    onSuccess: (c) => {
      toast({
        tone: 'success',
        title: 'Conversation started',
        description: `${c.staffParticipantUserIds.length} SimplexD team member${c.staffParticipantUserIds.length === 1 ? '' : 's'} added.`,
      });
      setOpen(false);
      setTitle('');
      setMessage('');
      router.push(`/partner/messages/${c.id}`);
    },
    onError: (err) =>
      toast({ tone: 'danger', title: 'Could not start', description: errorMessage(err) }),
  });
  const valid = selected !== null && title.trim().length >= 2 && message.trim().length >= 1;

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <MessageSquarePlus aria-hidden="true" className="h-4 w-4" />
        Start a conversation
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Start a conversation with the SimplexD team"
          description="Pick the work it is about. The staff responsible for it are added automatically; customers are never included unless staff add them."
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) start.mutate();
            }}
          >
            {loading ? (
              <p className="text-sm text-fg-muted">Loading your work…</p>
            ) : uniqueSubjects.length === 0 ? (
              <Alert tone="info" title="Nothing to talk about yet">
                Conversations are tied to an accepted assignment, an invited tender, an RFQ or a
                purchase order. None of these is on your account yet.
              </Alert>
            ) : (
              <Field label="About" htmlFor="conv-subject" required>
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={selected?.key ?? ''}
                    onChange={(e) => setSubjectKey(e.target.value)}
                  >
                    {uniqueSubjects.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            )}
            <Field label="Subject" htmlFor="conv-title" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </Field>
            <Field label="Message" htmlFor="conv-message" required>
              {({ id }) => (
                <Textarea
                  id={id}
                  value={message}
                  maxLength={20000}
                  onChange={(e) => setMessage(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={start.isPending} disabled={!valid}>
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

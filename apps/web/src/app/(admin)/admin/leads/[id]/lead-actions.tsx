'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { LeadConvertResult, LeadDetailDto, StaffAssigneeDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

const STATUSES = ['new', 'contacted', 'qualified', 'closed_lost', 'spam'] as const;

export function LeadActions({
  lead,
  assignees,
  services,
  canManage,
}: {
  lead: LeadDetailDto;
  assignees: StaffAssigneeDto[];
  services: Array<{ slug: string; name: string; category: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [status, setStatus] = useState<string>(lead.status);
  const [assignee, setAssignee] = useState<string>(lead.assignedToUserId ?? '');
  const [statusNote, setStatusNote] = useState('');
  const [note, setNote] = useState('');
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertService, setConvertService] = useState(
    lead.interestServiceSlug ?? services[0]?.slug ?? '',
  );
  const [convertTitle, setConvertTitle] = useState('');
  const [convertNote, setConvertNote] = useState('');
  const [result, setResult] = useState<LeadConvertResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, label: string, key: string) {
    setBusy(key);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/leads/${lead.id}`, { method: 'PATCH', body });
      toast({ title: label, tone: 'success' });
      setStatusNote('');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function addNote() {
    setBusy('note');
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/leads/${lead.id}/notes`, {
        method: 'POST',
        body: { body: note.trim() },
      });
      setNote('');
      toast({ title: 'Note added', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function convert() {
    setBusy('convert');
    setError(null);
    try {
      const res = await apiFetch<LeadConvertResult>(`/api/v1/admin/leads/${lead.id}/convert`, {
        method: 'POST',
        body: {
          serviceSlug: convertService || undefined,
          title: convertTitle.trim() || undefined,
          note: convertNote.trim() || undefined,
        },
      });
      setResult(res);
      setConvertOpen(false);
      toast({
        title:
          res.path === 'service_request_created'
            ? `Request ${res.reference} created`
            : 'Invitation queued',
        tone: 'success',
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!canManage) {
    return (
      <Alert tone="info" title="Read-only">
        Your role can read leads. Assigning, status changes and conversion need leads.manage.
      </Alert>
    );
  }
  const converted = lead.status === 'converted';
  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Action failed">
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Alert
          tone="success"
          title={
            result.path === 'service_request_created'
              ? 'Service request created'
              : 'Invitation email queued'
          }
        >
          {result.path === 'service_request_created' ? (
            <>
              {result.reference} is now in inquiry for the customer&apos;s organisation.{' '}
              <Link
                href={`/portal/requests/${result.serviceRequestId}`}
                className="text-primary underline"
              >
                Open request
              </Link>
            </>
          ) : (
            'No account matched this email, so an invitation with a sign-up link was queued through the outbox and the lead is marked contacted.'
          )}
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Status and assignment</CardTitle>
          <CardDescription>Changes are audited with before/after state.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Status">
            {({ id }) => (
              <NativeSelect
                id={id}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={converted}
              >
                {(converted ? ['converted'] : STATUSES).map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Note for this change (optional)">
            {({ id }) => (
              <Input
                id={id}
                value={statusNote}
                onChange={(e) => setStatusNote(e.target.value)}
                maxLength={4000}
              />
            )}
          </Field>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'status'}
            disabled={converted || status === lead.status}
            onClick={() =>
              void patch({ status, note: statusNote || undefined }, 'Status updated', 'status')
            }
          >
            Update status
          </Button>
          <Field label="Assign to" hint="Staff holding an active role.">
            {({ id }) => (
              <NativeSelect id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {assignees.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.name} ({a.roles.map(humanize).join(', ')})
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'assign'}
            disabled={assignee === (lead.assignedToUserId ?? '')}
            onClick={() =>
              void patch({ assignedToUserId: assignee || null }, 'Assignment updated', 'assign')
            }
          >
            Save assignment
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add internal note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Internal note"
            rows={3}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'note'}
            disabled={note.trim().length === 0}
            onClick={() => void addNote()}
          >
            Add note
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Convert</CardTitle>
          <CardDescription>
            <strong>Existing customer:</strong> if the lead&apos;s email belongs to a user with a
            customer organisation, a service request is created in inquiry and linked.{' '}
            <strong>No account:</strong> an invitation email with a sign-up link is queued through
            the outbox and the lead is marked contacted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            disabled={converted || lead.status === 'spam'}
            onClick={() => setConvertOpen(true)}
          >
            {converted ? 'Already converted' : 'Convert lead'}
          </Button>
          <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
            <DialogContent
              title="Convert lead"
              description={
                lead.linkedUser && lead.organizationName
                  ? `${lead.linkedUser.name} belongs to ${lead.organizationName}: a service request will be created.`
                  : lead.linkedUser
                    ? `${lead.linkedUser.name} has an account but no organisation yet: an invitation will be sent.`
                    : 'No account matches this email: an invitation will be sent.'
              }
              size="sm"
            >
              <div className="space-y-3">
                <Field label="Service" required>
                  {({ id }) => (
                    <NativeSelect
                      id={id}
                      value={convertService}
                      onChange={(e) => setConvertService(e.target.value)}
                    >
                      {services.map((s) => (
                        <option key={s.slug} value={s.slug}>
                          {s.name}
                          {s.category === 'expansion' ? ' (expansion)' : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field label="Request title (optional)">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={convertTitle}
                      onChange={(e) => setConvertTitle(e.target.value)}
                      maxLength={160}
                    />
                  )}
                </Field>
                <Field label="Internal note (optional)">
                  {({ id }) => (
                    <Textarea
                      id={id}
                      rows={2}
                      maxLength={2000}
                      value={convertNote}
                      onChange={(e) => setConvertNote(e.target.value)}
                    />
                  )}
                </Field>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => setConvertOpen(false)}
                    disabled={busy === 'convert'}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void convert()}
                    loading={busy === 'convert'}
                    loadingLabel="Converting"
                    disabled={!convertService}
                  >
                    Convert
                  </Button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}

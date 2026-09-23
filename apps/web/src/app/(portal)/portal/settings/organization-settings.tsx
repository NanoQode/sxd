'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ORG_ROLE_DESCRIPTIONS,
  type InvitableOrgRole,
  type OrganizationInvitationDto,
  type OrganizationMemberDto,
  type OrganizationMembershipDto,
} from '@simplexd/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  formatDateLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';
import { authClient } from '@/lib/auth/client';

const INVITABLE_ROLES: InvitableOrgRole[] = ['member', 'adviser', 'approver', 'owner'];

export function OrganizationSettings({
  active,
  memberships,
  members,
  invitations,
  currentUserId,
}: {
  active: OrganizationMembershipDto | null;
  memberships: OrganizationMembershipDto[];
  members: OrganizationMemberDto[];
  invitations: OrganizationInvitationDto[];
  currentUserId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(active?.name ?? '');
  const [ownershipType, setOwnershipType] = useState<'individual' | 'company'>(active?.ownershipType ?? 'individual');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InvitableOrgRole>('member');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);

  if (!active) {
    return (
      <Alert tone="warning" title="No active organisation">
        <Link href="/onboarding" className="font-medium text-primary underline">
          Create your organisation
        </Link>{' '}
        or accept an invitation to manage members and settings.
      </Alert>
    );
  }
  const canManage = active.role === 'owner';
  const canInvite = active.role === 'owner' || active.role === 'member';
  const otherOwners = members.filter((m) => m.role === 'owner' && m.userId !== currentUserId).length;

  async function saveOrganization() {
    setBusy('org');
    setError(null);
    try {
      await apiFetch('/api/v1/me/organizations', { method: 'PATCH', body: { name: name.trim(), ownershipType } });
      toast({ title: 'Organisation updated', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function invite() {
    setBusy('invite');
    setError(null);
    try {
      await apiFetch('/api/v1/me/organizations/invitations', { method: 'POST', body: { email: inviteEmail.trim(), role: inviteRole } });
      setInviteEmail('');
      toast({ title: 'Invitation sent', description: 'The invitation email is queued and expires in 7 days.', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(`revoke:${id}`);
    setError(null);
    try {
      await apiFetch(`/api/v1/me/organizations/invitations/${id}`, { method: 'DELETE' });
      toast({ title: 'Invitation revoked', tone: 'success' });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function leave() {
    if (!active) return;
    setBusy('leave');
    setError(null);
    const res = await authClient.organization.leave({ organizationId: active.organizationId });
    if (res.error) {
      setError(res.error.message ?? 'Could not leave the organisation.');
      setBusy(null);
      return;
    }
    const remaining = memberships.filter((m) => m.organizationId !== active.organizationId);
    if (remaining[0]) await authClient.organization.setActive({ organizationId: remaining[0].organizationId });
    queryClient.clear();
    setLeaveOpen(false);
    setBusy(null);
    toast({ title: `You left ${active.name}`, tone: 'success' });
    router.push('/portal');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Alert tone="danger" title="Something went wrong">
          {error}
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{active.name}</CardTitle>
          <CardDescription>
            Your role: <Badge tone="primary">{humanize(active.role)}</Badge>. {ORG_ROLE_DESCRIPTIONS[(active.role === 'tenant' ? 'member' : active.role) as InvitableOrgRole]}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canManage ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveOrganization();
              }}
              className="grid gap-4 sm:grid-cols-2"
            >
              <Field label="Organisation name" required>
                {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} />}
              </Field>
              <Field label="Ownership type" hint="Individual or company; affects invoicing details and document requirements.">
                {({ id }) => (
                  <NativeSelect id={id} value={ownershipType} onChange={(e) => setOwnershipType(e.target.value as 'individual' | 'company')}>
                    <option value="individual">Individual or household</option>
                    <option value="company">Company</option>
                  </NativeSelect>
                )}
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" loading={busy === 'org'} loadingLabel="Saving">
                  Save organisation
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-fg-muted">
              Ownership type: {humanize(active.ownershipType)}. Only owners can change organisation settings.
            </p>
          )}
          {memberships.length > 1 ? (
            <p className="text-sm text-fg-muted">
              You belong to {memberships.length} organisations. Switch between them from the header; switching resets what is shown.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Household members and advisers with explicit view, comment or approval rights.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <DataTable
            caption="Organisation members"
            rows={members}
            rowKey={(m) => m.id}
            rowLabel={(m) => m.name}
            emptyMessage="Members could not be listed for your role."
            columns={[
              { key: 'name', header: 'Name', cell: (m) => <span className="font-medium">{m.name}{m.userId === currentUserId ? ' (you)' : ''}</span> },
              { key: 'email', header: 'Email', cell: (m) => m.email },
              { key: 'role', header: 'Role', cell: (m) => <Badge tone={m.role === 'owner' ? 'primary' : 'neutral'}>{humanize(m.role)}</Badge> },
              { key: 'since', header: 'Since', cell: (m) => formatDateLabel(m.createdAt), hideOnMobile: true },
            ]}
          />
          {canInvite ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void invite();
              }}
              className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
            >
              <Field label="Invite by email" required>
                {({ id }) => <Input id={id} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />}
              </Field>
              <Field label="Role" hint={ORG_ROLE_DESCRIPTIONS[inviteRole]}>
                {({ id }) => (
                  <NativeSelect id={id} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InvitableOrgRole)} className="min-w-[10rem]">
                    {INVITABLE_ROLES.filter((r) => r !== 'owner' || canManage).map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Button type="submit" loading={busy === 'invite'} loadingLabel="Sending">
                Send invitation
              </Button>
            </form>
          ) : (
            <p className="text-sm text-fg-muted">Your role cannot invite members; ask an owner.</p>
          )}
          {invitations.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">Pending invitations</h3>
              <ul className="space-y-2">
                {invitations.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                    <span>
                      <span className="font-medium">{inv.email}</span> as {humanize(inv.role)} · {inv.status === 'expired' ? 'expired' : `expires ${formatDateLabel(inv.expiresAt)}`}
                      {inv.inviterName ? ` · invited by ${inv.inviterName}` : ''}
                    </span>
                    {canInvite ? (
                      <Button variant="secondary" size="sm" loading={busy === `revoke:${inv.id}`} onClick={() => void revoke(inv.id)}>
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leave this organisation</CardTitle>
          <CardDescription>
            {active.role === 'owner' && otherOwners === 0
              ? 'You are the only owner. Invite another owner before leaving so the organisation keeps an administrator.'
              : 'You lose access to its requests, documents and invoices immediately.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="danger" disabled={active.role === 'owner' && otherOwners === 0} onClick={() => setLeaveOpen(true)}>
            Leave {active.name}
          </Button>
          <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
            <DialogContent title={`Leave ${active.name}?`} description="This removes your membership now. An owner can invite you again later." size="sm">
              <DialogFooter>
                <Button variant="ghost" onClick={() => setLeaveOpen(false)} disabled={busy === 'leave'}>
                  Stay
                </Button>
                <Button variant="danger" onClick={() => void leave()} loading={busy === 'leave'} loadingLabel="Leaving">
                  Leave organisation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}

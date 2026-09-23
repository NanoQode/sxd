'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STAFF_ROLES, type StaffRole } from '@simplexd/domain/authz';
import { Badge, Button, DataTable, Field, Input, NativeSelect, useToast, type Column } from '@simplexd/ui';
import { apiFetch } from '@/lib/api/client-fetch';
import type { StaffUserDto } from '@/server/admin/access/staff-roles';
import { ActionDialog } from '../_components/action-dialog';

export function StaffRolesManager({
  users,
  actorId,
  roleDescriptions,
  canManage,
}: {
  users: StaffUserDto[];
  actorId: string;
  roleDescriptions: Record<StaffRole, { scope: string; exclusions: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [grant, setGrant] = useState<{ email: string; role: StaffRole } | null>(null);
  const [revoke, setRevoke] = useState<{ user: StaffUserDto; role: StaffRole } | null>(null);

  async function doGrant(reason: string) {
    if (!grant) return;
    await apiFetch('/api/v1/admin/staff-roles', { body: { action: 'grant', email: grant.email.trim(), role: grant.role, reason } });
    toast({ title: `Granted ${grant.role}`, tone: 'success' });
    router.refresh();
  }
  async function doRevoke(reason: string) {
    if (!revoke) return;
    await apiFetch('/api/v1/admin/staff-roles', { body: { action: 'revoke', userId: revoke.user.id, role: revoke.role, reason } });
    toast({ title: `Revoked ${revoke.role}`, tone: 'success' });
    router.refresh();
  }

  const columns: Column<StaffUserDto>[] = [
    { key: 'user', header: 'User', cell: (u) => <span className="font-medium">{u.name}<span className="block text-xs text-fg-muted">{u.email}</span></span> },
    { key: 'roles', header: 'Roles', cell: (u) => (
      <div className="flex flex-wrap gap-1">
        {u.roles.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1">
            <Badge tone={r.role === 'super_admin' ? 'gold' : 'primary'}>{r.role.replace(/_/g, ' ')}</Badge>
            {canManage && !(r.role === 'super_admin' && u.id === actorId) ? <button type="button" className="sx-touch text-xs text-danger underline" onClick={() => setRevoke({ user: u, role: r.role })}>revoke</button> : null}
          </span>
        ))}
      </div>
    ) },
    { key: 'mfa', header: 'MFA', cell: (u) => <Badge tone={u.twoFactorEnabled ? 'success' : 'warning'}>{u.twoFactorEnabled ? 'Verified' : 'Not enrolled'}</Badge> },
    { key: 'status', header: 'Account', cell: (u) => (u.banned ? <Badge tone="danger">Banned</Badge> : u.emailVerified ? 'Verified email' : 'Email unverified') },
  ];

  return (
    <div className="space-y-6">
      {canManage ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg-elevated p-3">
          <Field label="User email" className="min-w-64 flex-1" hint="The person must already have an account.">
            {({ id }) => <Input id={id} type="email" value={grant?.email ?? ''} onChange={(e) => setGrant({ email: e.target.value, role: grant?.role ?? 'data_editor' })} />}
          </Field>
          <Field label="Role">
            {({ id }) => (
              <NativeSelect id={id} value={grant?.role ?? 'data_editor'} onChange={(e) => setGrant({ email: grant?.email ?? '', role: e.target.value as StaffRole })}>
                {STAFF_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </NativeSelect>
            )}
          </Field>
          <GrantButton grant={grant} onClick={() => setGrant((g) => (g ? { ...g, confirm: true } as typeof g : g))} />
        </div>
      ) : null}
      <DataTable columns={columns} rows={users} rowKey={(u) => u.id} rowLabel={(u) => u.name} caption="Staff members" emptyMessage="No staff roles granted." />
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Role matrix</h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {STAFF_ROLES.map((r) => (
            <li key={r} className="rounded-md border border-border bg-bg-elevated p-3 text-sm">
              <p className="font-medium">{r.replace(/_/g, ' ')}</p>
              <p className="text-fg-muted">{roleDescriptions[r].scope}</p>
              <p className="text-xs text-fg-subtle">Excluded: {roleDescriptions[r].exclusions}</p>
            </li>
          ))}
        </ul>
      </section>
      <ActionDialog open={Boolean(grant && (grant as { confirm?: boolean }).confirm)} onOpenChange={(o) => !o && setGrant(grant ? { email: grant.email, role: grant.role } : null)} title={grant ? `Grant ${grant.role.replace(/_/g, ' ')} to ${grant.email}` : ''} description={grant ? roleDescriptions[grant.role].scope : undefined} confirmLabel="Grant role" requireReason onConfirm={doGrant} />
      <ActionDialog open={revoke !== null} onOpenChange={(o) => !o && setRevoke(null)} title={revoke ? `Revoke ${revoke.role.replace(/_/g, ' ')} from ${revoke.user.name}` : ''} description="Access is removed immediately; the grant history stays in the audit log." confirmLabel="Revoke" tone="danger" requireReason onConfirm={doRevoke} />
    </div>
  );
}

function GrantButton({ grant, onClick }: { grant: { email: string } | null; onClick: () => void }) {
  const valid = Boolean(grant && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(grant.email));
  return <Button disabled={!valid} onClick={onClick}>Grant role…</Button>;
}

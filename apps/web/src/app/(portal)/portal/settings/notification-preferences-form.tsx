'use client';

import { useState } from 'react';
import type { NotificationPreferenceItem, NotificationPreferencesDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Switch,
  useToast,
} from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

const CHANNELS: Array<{ key: NotificationPreferenceItem['channel']; label: string }> = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'in_app', label: 'In-app' },
];
const CATEGORIES: Array<{
  key: NotificationPreferenceItem['category'];
  label: string;
  description: string;
}> = [
  {
    key: 'security',
    label: 'Security',
    description: 'Sign-in, password and access changes. Always on.',
  },
  {
    key: 'transactional',
    label: 'Transactional',
    description: 'Quotes, invoices, reports and decisions on your requests.',
  },
  {
    key: 'reminders',
    label: 'Reminders',
    description: 'Upcoming visits, due invoices and pending approvals.',
  },
  { key: 'digests', label: 'Digests', description: 'Daily or weekly summaries of activity.' },
  {
    key: 'marketing',
    label: 'Marketing',
    description: 'Product news and offers. Requires your consent.',
  },
];

export function NotificationPreferencesForm({
  initial,
  hasPhone,
}: {
  initial: NotificationPreferencesDto;
  hasPhone: boolean;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<NotificationPreferenceItem[]>(initial.items);
  const [quietEnabled, setQuietEnabled] = useState(Boolean(initial.quietHours));
  const [quietStart, setQuietStart] = useState(initial.quietHours?.start ?? '21:00');
  const [quietEnd, setQuietEnd] = useState(initial.quietHours?.end ?? '07:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = new Set(initial.lockedCategories);

  function update(
    channel: NotificationPreferenceItem['channel'],
    category: NotificationPreferenceItem['category'],
    patch: Partial<NotificationPreferenceItem>,
  ) {
    setItems((prev) =>
      prev.map((i) => (i.channel === channel && i.category === category ? { ...i, ...patch } : i)),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await apiFetch<NotificationPreferencesDto>(
        '/api/v1/me/notification-preferences',
        {
          method: 'PUT',
          body: { items, quietHours: quietEnabled ? { start: quietStart, end: quietEnd } : null },
        },
      );
      setItems(saved.items);
      toast({ title: 'Notification preferences saved', tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channels and categories</CardTitle>
        <CardDescription>
          Choose how you hear from us. Security messages follow product policy and stay on. SMS
          needs a phone number on your profile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <Alert tone="danger" title="Could not save">
            {error}
          </Alert>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <caption className="sr-only">Notification preferences by channel and category</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Category
                </th>
                {CHANNELS.map((c) => (
                  <th key={c.key} scope="col" className="py-2 pr-3 font-medium">
                    {c.label}
                  </th>
                ))}
                <th scope="col" className="py-2 font-medium">
                  Digest
                </th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((cat) => {
                const emailItem = items.find(
                  (i) => i.channel === 'email' && i.category === cat.key,
                );
                return (
                  <tr key={cat.key} className="border-t border-border align-top">
                    <th scope="row" className="py-3 pr-3 text-left font-normal">
                      <span className="font-medium">{cat.label}</span>
                      <br />
                      <span className="text-xs text-fg-muted">{cat.description}</span>
                    </th>
                    {CHANNELS.map((c) => {
                      const item = items.find((i) => i.channel === c.key && i.category === cat.key);
                      const disabled = locked.has(cat.key) || (c.key === 'sms' && !hasPhone);
                      return (
                        <td key={c.key} className="py-3 pr-3">
                          <Switch
                            checked={item?.enabled ?? false}
                            disabled={disabled}
                            label={`${cat.label} by ${c.label}`}
                            onCheckedChange={(v) => update(c.key, cat.key, { enabled: v })}
                          />
                          {c.key === 'sms' && !hasPhone ? (
                            <p className="mt-1 text-xs text-fg-subtle">Add a phone first</p>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="py-3">
                      {cat.key === 'digests' || cat.key === 'reminders' ? (
                        <NativeSelect
                          aria-label={`${cat.label} digest frequency`}
                          className="h-9 max-w-[9rem] text-sm"
                          value={emailItem?.digest ?? 'none'}
                          onChange={(e) =>
                            update('email', cat.key, {
                              digest: e.target.value as NotificationPreferenceItem['digest'],
                            })
                          }
                        >
                          <option value="none">Immediately</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                        </NativeSelect>
                      ) : (
                        <span className="text-xs text-fg-subtle">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={quietEnabled}
              onCheckedChange={setQuietEnabled}
              id="quiet-hours"
              label="Quiet hours for non-urgent notifications"
            />
            <label htmlFor="quiet-hours" className="text-sm font-medium">
              Quiet hours for non-urgent notifications
            </label>
          </div>
          <p className="text-sm text-fg-muted">
            Reminders, digests and marketing are held until quiet hours end (in{' '}
            {initial.timeZone ?? 'your time zone'}). Security and urgent decisions are never held.
          </p>
          {quietEnabled ? (
            <div className="flex flex-wrap gap-4">
              <Field label="From">
                {({ id }) => (
                  <Input
                    id={id}
                    type="time"
                    value={quietStart}
                    onChange={(e) => setQuietStart(e.target.value)}
                    className="max-w-[9rem]"
                  />
                )}
              </Field>
              <Field label="Until">
                {({ id }) => (
                  <Input
                    id={id}
                    type="time"
                    value={quietEnd}
                    onChange={(e) => setQuietEnd(e.target.value)}
                    className="max-w-[9rem]"
                  />
                )}
              </Field>
            </div>
          ) : null}
        </div>
        <Button onClick={() => void save()} loading={busy} loadingLabel="Saving">
          Save notification preferences
        </Button>
      </CardContent>
    </Card>
  );
}

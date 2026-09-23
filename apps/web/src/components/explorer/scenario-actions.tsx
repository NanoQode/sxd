'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Copy, Save, Share2, ShieldQuestion, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Dialog, DialogContent, DialogFooter, Field, Input, Textarea, useToast } from '@simplexd/ui';
import { formatDateTimeLabel } from '@simplexd/ui/format';
import { emailSchema } from '@simplexd/contracts';
import { useSession } from '@/lib/auth/client';
import { defaultScenarioName } from '@/lib/explorer';
import { useExplorer } from './explorer-context';

/**
 * Save (anonymous or owned), share, claim, request local verification and
 * start a service from the current scenario. The scenario id is kept in the
 * URL and localStorage so a reload preserves it.
 */

const verificationSchema = z.object({
  contactName: z.string().trim().min(2, 'Enter your name').max(120),
  email: emailSchema,
  message: z.string().trim().max(2000, 'Keep the message under 2000 characters'),
});
type VerificationForm = z.infer<typeof verificationSchema>;

export interface ScenarioActionsHandle {
  openSave: () => void;
  openVerification: () => void;
}

export function ScenarioActions({
  saveOpen,
  onSaveOpenChange,
  verificationOpen,
  onVerificationOpenChange,
  compact = false,
}: {
  saveOpen: boolean;
  onSaveOpenChange: (open: boolean) => void;
  verificationOpen: boolean;
  onVerificationOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const { scenario, scenarioName, setScenarioName, filters, selectedSlug, mode } = useExplorer();
  const { data: session } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const [nameDraft, setNameDraft] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const form = useForm<VerificationForm>({
    resolver: zodResolver(verificationSchema),
    defaultValues: { contactName: '', email: session?.user.email ?? '', message: '' },
  });

  const openSave = () => {
    setNameDraft(scenarioName || defaultScenarioName(filters.objective));
    onSaveOpenChange(true);
  };

  const submitSave = async () => {
    const name = nameDraft.trim() || defaultScenarioName(filters.objective);
    setScenarioName(name);
    const saved = await scenario.save(name);
    if (saved) onSaveOpenChange(false);
  };

  const share = async () => {
    const url = await scenario.share();
    if (!url) return;
    setShareUrl(url);
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Share link copied', description: url, tone: 'success' });
    } catch {
      setShareOpen(true);
    }
  };

  const startService = async () => {
    const saved = scenario.dto && !scenario.dirty ? scenario.dto : await scenario.save();
    if (!saved) return;
    router.push(`/book?scenario=${encodeURIComponent(saved.id)}${selectedSlug ? `&market=${encodeURIComponent(selectedSlug)}` : ''}`);
  };

  const submitVerification = form.handleSubmit(async (values) => {
    const ok = await scenario.requestVerification(values);
    if (ok) {
      onVerificationOpenChange(false);
      form.reset({ contactName: values.contactName, email: values.email, message: '' });
    }
  });

  const status = scenario.shared
    ? 'Viewing a shared scenario (read-only). Save a copy to edit it.'
    : scenario.dto
      ? `Saved ${formatDateTimeLabel(scenario.dto.updatedAt)} · ${
          scenario.dto.isAnonymous ? 'anonymous: kept on this device and in the link' : 'in your account'
        }${scenario.dirty ? ' · unsaved changes' : ''}${
          scenario.dto.verificationRequestedAt ? ` · verification requested ${formatDateTimeLabel(scenario.dto.verificationRequestedAt)}` : ''
        }`
      : 'Not saved yet. Saving keeps the filters, priorities, compared markets and assumptions.';

  return (
    <section aria-labelledby="scenario-actions-heading" className="space-y-2" data-testid="scenario-actions">
      <h2 id="scenario-actions-heading" className="text-sm font-semibold">
        {scenario.dto ? scenario.dto.name : 'Your scenario'}
        {mode === 'assumption' ? <span className="ml-1 text-xs font-normal text-fg-muted">(assumption mode)</span> : null}
      </h2>
      <p className="text-xs text-fg-muted" aria-live="polite">
        {status}
      </p>
      {scenario.error ? (
        <Alert tone="warning" title="Saved scenario could not be loaded">
          The link&apos;s scenario is not available (it may have expired or belong to another account).{' '}
          <button type="button" className="underline" onClick={scenario.refetch}>
            Retry
          </button>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={openSave} loading={scenario.busy === 'saving'} loadingLabel="Saving…" disabled={Boolean(scenario.dto) && !scenario.dirty && !scenario.shared}>
          <Save aria-hidden="true" className="h-4 w-4" />
          {scenario.shared ? 'Save a copy' : scenario.dto ? (scenario.dirty ? 'Save changes' : 'Saved') : 'Save scenario'}
        </Button>
        {!compact ? (
          <Button variant="secondary" onClick={() => void share()} loading={scenario.busy === 'sharing'} loadingLabel="Creating link…">
            <Share2 aria-hidden="true" className="h-4 w-4" /> Share link
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => onVerificationOpenChange(true)}>
          <ShieldQuestion aria-hidden="true" className="h-4 w-4" /> Request local verification
        </Button>
        {scenario.dto && !scenario.dirty ? (
          <Link href={`/book?scenario=${encodeURIComponent(scenario.dto.id)}${selectedSlug ? `&market=${encodeURIComponent(selectedSlug)}` : ''}`} className="inline-flex">
            <Button variant="accent">
              Start a service <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Button>
          </Link>
        ) : (
          <Button variant="accent" onClick={() => void startService()} loading={scenario.busy === 'saving'} loadingLabel="Saving…">
            Start a service <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
        {scenario.dto?.isAnonymous && session ? (
          <Button variant="secondary" onClick={() => void scenario.claim()} loading={scenario.busy === 'claiming'} loadingLabel="Claiming…">
            <UserCheck aria-hidden="true" className="h-4 w-4" /> Add to my account
          </Button>
        ) : null}
      </div>
      {!session && !scenario.dto ? (
        <p className="text-xs text-fg-muted">
          Anonymous saves stay on this device and in the link.{' '}
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>{' '}
          to keep scenarios in your account.
        </p>
      ) : null}

      <Dialog open={saveOpen} onOpenChange={onSaveOpenChange}>
        <DialogContent title={scenario.shared ? 'Save a copy of this scenario' : 'Save scenario'} description="Filters, priorities, compared markets and assumptions are stored with a policy version so the result can be reproduced.">
          <Field label="Scenario name">
            {({ id }) => (
              <Input
                id={id}
                value={nameDraft}
                maxLength={120}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitSave();
                }}
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onSaveOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitSave()} loading={scenario.busy === 'saving'} loadingLabel="Saving…">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={verificationOpen} onOpenChange={onVerificationOpenChange}>
        <DialogContent title="Request local verification" description="A SimplexD researcher checks the local evidence behind this scenario (comparables, supplier quotes, approvals, site checks) and replies by email. The scenario is saved first.">
          <form onSubmit={(event) => void submitVerification(event)} className="space-y-3" noValidate>
            <Field label="Your name" required error={form.formState.errors.contactName?.message}>
              {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="name" {...form.register('contactName')} />}
            </Field>
            <Field label="Email" required error={form.formState.errors.email?.message}>
              {({ id, describedBy, invalid }) => <Input id={id} type="email" aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="email" {...form.register('email')} />}
            </Field>
            <Field label="What should be verified?" hint="Optional: neighbourhoods, plot details, materials or approvals you care about." error={form.formState.errors.message?.message}>
              {({ id, describedBy, invalid }) => <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...form.register('message')} />}
            </Field>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => onVerificationOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={scenario.busy === 'verifying'} loadingLabel="Sending…">
                Send request
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent title="Share link" description="Anyone with this link can view the scenario (read-only).">
          <div className="flex gap-2">
            <Input readOnly value={shareUrl ?? ''} aria-label="Share link" onFocus={(event) => event.currentTarget.select()} />
            <Button
              size="icon"
              variant="secondary"
              aria-label="Copy share link"
              onClick={() => {
                if (shareUrl) void navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
              }}
            >
              <Copy aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

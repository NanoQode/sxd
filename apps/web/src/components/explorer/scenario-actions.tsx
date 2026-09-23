'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Copy, Save, Share2, ShieldQuestion, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { formatDateTimeLabel } from '@simplexd/ui/format';
import { emailSchema, type ScenarioDto } from '@simplexd/contracts';
import { useSession } from '@/lib/auth/client';
import { defaultScenarioName } from '@/lib/explorer';
import { useExplorer } from './explorer-context';

/**
 * Save, share, claim, request local verification and start a service from the
 * current scenario. The scenario id is kept in the URL and localStorage so a
 * reload preserves it. Every action passes the account gate first (brief §5):
 * an anonymous visitor is sent to sign-in with the explorer state preserved
 * and, on return, the dialog for the action they chose opens again pre-filled
 * (`resumeIntent`); sharing and starting a service continue right after the
 * confirming save so nothing is created silently.
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
  const {
    scenario,
    scenarioName,
    setScenarioName,
    filters,
    selectedSlug,
    mode,
    access,
    requireAccount,
    resumeIntent,
    clearResumeIntent,
    signInHref,
    signUpHref,
  } = useExplorer();
  const { data: session } = useSession();
  const signedIn = access.signedIn || Boolean(session);
  const { toast } = useToast();
  const router = useRouter();
  const [nameDraft, setNameDraft] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const form = useForm<VerificationForm>({
    resolver: zodResolver(verificationSchema),
    defaultValues: { contactName: '', email: session?.user.email ?? '', message: '' },
  });

  // The dialog can be opened from the location panel or by a resumed intent
  // as well as from here: pre-fill the name whenever it opens (derived state
  // during render, the same pattern the filter inputs use).
  const [prefilledFor, setPrefilledFor] = useState(false);
  if (saveOpen && !prefilledFor) {
    setPrefilledFor(true);
    setNameDraft(scenarioName || defaultScenarioName(filters.objective));
  } else if (!saveOpen && prefilledFor) {
    setPrefilledFor(false);
  }

  const bookHref = (scenarioId: string): string =>
    `/book?scenario=${encodeURIComponent(scenarioId)}${
      selectedSlug ? `&market=${encodeURIComponent(selectedSlug)}` : ''
    }`;

  const openSave = () => {
    if (!requireAccount('save')) return;
    onSaveOpenChange(true);
  };

  const closeSave = () => {
    onSaveOpenChange(false);
    clearResumeIntent();
  };

  const shareSaved = async (saved: ScenarioDto | null) => {
    if (!saved) return;
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

  const submitSave = async () => {
    const name = nameDraft.trim() || defaultScenarioName(filters.objective);
    setScenarioName(name);
    const saved = await scenario.save(name);
    if (!saved) return;
    onSaveOpenChange(false);
    const continuation = resumeIntent;
    clearResumeIntent();
    // The visitor clicked Share or Start a service before signing in: the
    // confirming save above is the one click they get, then the action finishes.
    if (continuation === 'share') await shareSaved(saved);
    else if (continuation === 'service') router.push(bookHref(saved.id));
  };

  const share = async () => {
    if (!requireAccount('share')) return;
    const saved = scenario.dto && !scenario.dirty ? scenario.dto : await scenario.save();
    await shareSaved(saved);
  };

  const startService = async () => {
    if (!requireAccount('service')) return;
    const saved = scenario.dto && !scenario.dirty ? scenario.dto : await scenario.save();
    if (!saved) return;
    router.push(bookHref(saved.id));
  };

  const openVerification = () => {
    if (!requireAccount('verify')) return;
    onVerificationOpenChange(true);
  };

  const closeVerification = () => {
    onVerificationOpenChange(false);
    clearResumeIntent();
  };

  const submitVerification = form.handleSubmit(async (values) => {
    const ok = await scenario.requestVerification(values);
    if (ok) {
      closeVerification();
      form.reset({ contactName: values.contactName, email: values.email, message: '' });
    }
  });

  const saveDescription =
    resumeIntent === 'share'
      ? 'Filters, priorities, compared markets and assumptions are stored with a policy version. The private share link is created right after this save.'
      : resumeIntent === 'service'
        ? 'Filters, priorities, compared markets and assumptions are stored with a policy version. You continue to the booking form right after this save.'
        : 'Filters, priorities, compared markets and assumptions are stored with a policy version so the result can be reproduced.';

  const status = scenario.shared
    ? 'Viewing a shared scenario (read-only). Save a copy to edit it.'
    : scenario.dto
      ? `Saved ${formatDateTimeLabel(scenario.dto.updatedAt)} · ${
          scenario.dto.isAnonymous
            ? 'anonymous: kept on this device and in the link'
            : 'in your account'
        }${scenario.dirty ? ' · unsaved changes' : ''}${
          scenario.dto.verificationRequestedAt
            ? ` · verification requested ${formatDateTimeLabel(scenario.dto.verificationRequestedAt)}`
            : ''
        }`
      : 'Not saved yet. Saving keeps the filters, priorities, compared markets and assumptions.';

  return (
    <section
      aria-labelledby="scenario-actions-heading"
      className="space-y-2"
      data-testid="scenario-actions"
    >
      <h2 id="scenario-actions-heading" className="text-sm font-semibold">
        {scenario.dto ? scenario.dto.name : 'Your scenario'}
        {mode === 'assumption' ? (
          <span className="ml-1 text-xs font-normal text-fg-muted">(assumption mode)</span>
        ) : null}
      </h2>
      <p className="text-xs text-fg-muted" aria-live="polite">
        {status}
      </p>
      {scenario.error ? (
        <Alert tone="warning" title="Saved scenario could not be loaded">
          The link&apos;s scenario is not available (it may have expired or belong to another
          account).{' '}
          <button type="button" className="underline" onClick={scenario.refetch}>
            Retry
          </button>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={openSave}
          loading={scenario.busy === 'saving'}
          loadingLabel="Saving…"
          disabled={Boolean(scenario.dto) && !scenario.dirty && !scenario.shared}
        >
          <Save aria-hidden="true" className="h-4 w-4" />
          {scenario.shared
            ? 'Save a copy'
            : scenario.dto
              ? scenario.dirty
                ? 'Save changes'
                : 'Saved'
              : 'Save scenario'}
        </Button>
        {!compact ? (
          <Button
            variant="secondary"
            onClick={() => void share()}
            loading={scenario.busy === 'sharing'}
            loadingLabel="Creating link…"
          >
            <Share2 aria-hidden="true" className="h-4 w-4" /> Share link
          </Button>
        ) : null}
        <Button variant="secondary" onClick={openVerification}>
          <ShieldQuestion aria-hidden="true" className="h-4 w-4" /> Request local verification
        </Button>
        <Button
          variant="accent"
          onClick={() => void startService()}
          loading={scenario.busy === 'saving' && !saveOpen}
          loadingLabel="Saving…"
        >
          Start a service <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Button>
        {scenario.dto?.isAnonymous && signedIn ? (
          <Button
            variant="secondary"
            onClick={() => void scenario.claim()}
            loading={scenario.busy === 'claiming'}
            loadingLabel="Claiming…"
          >
            <UserCheck aria-hidden="true" className="h-4 w-4" /> Add to my account
          </Button>
        ) : null}
      </div>
      {!signedIn && !scenario.dto ? (
        <p className="text-xs text-fg-muted" data-testid="account-hint">
          {access.anonymousSavesAllowed ? (
            <>
              Anonymous saves stay on this device and in the link.{' '}
              <Link href={signInHref} className="underline">
                Sign in
              </Link>{' '}
              to keep scenarios in your account.
            </>
          ) : (
            <>
              Exploring, filtering, comparing and calculator estimates need no account. Saving,
              sharing, local verification and starting a service do:{' '}
              <Link href={signInHref} className="underline">
                sign in
              </Link>{' '}
              or{' '}
              <Link href={signUpHref} className="underline">
                create an account
              </Link>{' '}
              and your filters, compared markets and assumptions come with you.
            </>
          )}
        </p>
      ) : null}

      <Dialog
        open={saveOpen}
        onOpenChange={(open) => (open ? onSaveOpenChange(true) : closeSave())}
      >
        <DialogContent
          title={scenario.shared ? 'Save a copy of this scenario' : 'Save scenario'}
          description={saveDescription}
        >
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
            <Button variant="ghost" onClick={closeSave}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitSave()}
              loading={scenario.busy === 'saving'}
              loadingLabel="Saving…"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={verificationOpen}
        onOpenChange={(open) => (open ? onVerificationOpenChange(true) : closeVerification())}
      >
        <DialogContent
          title="Request local verification"
          description="A SimplexD researcher checks the local evidence behind this scenario (comparables, supplier quotes, approvals, site checks) and replies by email. The scenario is saved first."
        >
          <form
            onSubmit={(event) => void submitVerification(event)}
            className="space-y-3"
            noValidate
          >
            <Field label="Your name" required error={form.formState.errors.contactName?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  autoComplete="name"
                  {...form.register('contactName')}
                />
              )}
            </Field>
            <Field label="Email" required error={form.formState.errors.email?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="email"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  autoComplete="email"
                  {...form.register('email')}
                />
              )}
            </Field>
            <Field
              label="What should be verified?"
              hint="Optional: neighbourhoods, plot details, materials or approvals you care about."
              error={form.formState.errors.message?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  {...form.register('message')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={closeVerification}>
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
        <DialogContent
          title="Share link"
          description="Anyone with this link can view the scenario (read-only)."
        >
          <div className="flex gap-2">
            <Input
              readOnly
              value={shareUrl ?? ''}
              aria-label="Share link"
              onFocus={(event) => event.currentTarget.select()}
            />
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

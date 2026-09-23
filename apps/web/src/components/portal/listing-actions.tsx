'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { ListingDetailDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';
import { ListingForm, type ListableProperty } from './listing-form';
import type { ListingMediaFileDto } from '@simplexd/contracts';

type Err = { message: string; correlationId: string | null } | null;

/**
 * One confirmed portal mutation: opens a dialog (optionally requiring a
 * reason), posts, toasts and refreshes. The server re-checks the permission
 * and the optimistic version on every call.
 */
export function ConfirmedAction({
  label,
  title,
  description,
  path,
  body,
  reasonKey,
  reasonLabel = 'Reason',
  confirmLabel = 'Confirm',
  variant = 'secondary',
  tone = 'primary',
  successTitle,
  disabled,
  disabledReason,
}: {
  label: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  path: string;
  body: Record<string, unknown>;
  /** When set, a reason is required and sent under this key. */
  reasonKey?: string;
  reasonLabel?: string;
  confirmLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  tone?: 'primary' | 'danger';
  successTitle: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  async function run() {
    if (reasonKey && reason.trim().length < 3) {
      setError({ message: 'A short reason is required.', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch(path, { body: reasonKey ? { ...body, [reasonKey]: reason.trim() } : body });
      toast({ title: successTitle, tone: 'success' });
      setOpen(false);
      setReason('');
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {disabled && disabledReason ? <span className="sr-only">{disabledReason}</span> : null}
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent title={title} description={description}>
          {error ? (
            <ErrorState
              title="Not done"
              message={error.message}
              correlationId={error.correlationId}
            />
          ) : null}
          {reasonKey ? (
            <Field label={reasonLabel} htmlFor="ca-reason" required>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  rows={3}
                  aria-describedby={describedBy}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              disabled={busy}
              onClick={() => void run()}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Owner actions for one listing: submit, re-confirm, withdraw, plus the revise dialog. */
export function ListingOwnerActions({
  listing,
  canManage,
  media,
}: {
  listing: ListingDetailDto;
  canManage: boolean;
  media: ListingMediaFileDto[];
}) {
  const [editing, setEditing] = useState(false);
  if (!canManage) return null;
  const status = listing.effectiveStatus;
  const authorityOk = listing.ownerAuthority?.effectiveStatus === 'verified';
  const editable =
    ['draft', 'rejected', 'in_moderation', 'published', 'expired'].includes(listing.status) &&
    !listing.duplicateOfListingId;
  const canSubmit =
    !listing.duplicateOfListingId &&
    (status === 'draft' ||
      status === 'rejected' ||
      status === 'expired' ||
      (status === 'published' && listing.hasUnpublishedChanges));
  const live =
    (listing.status === 'published' || listing.status === 'in_moderation') &&
    listing.publishedVersion !== null &&
    status !== 'expired';
  const withdrawable = [
    'draft',
    'rejected',
    'published',
    'in_moderation',
    'expired',
    'paused',
  ].includes(status);
  const noProperties: ListableProperty[] = [];
  return (
    <div className="flex flex-wrap gap-2">
      {editable ? (
        <>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit (new revision)
          </Button>
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent
              title={`Revise ${listing.title}`}
              description={`Version ${listing.version}; a concurrent edit is refused, never overwritten.`}
              size="lg"
            >
              <ListingForm
                listing={listing}
                properties={noProperties}
                media={media}
                onDone={() => setEditing(false)}
              />
            </DialogContent>
          </Dialog>
        </>
      ) : null}
      {canSubmit ? (
        <ConfirmedAction
          label={
            status === 'expired'
              ? 'Re-confirm and resubmit'
              : listing.publishedVersion !== null
                ? 'Submit changes for moderation'
                : 'Submit for moderation'
          }
          title="Submit for moderation?"
          description={
            authorityOk
              ? 'Staff check the owner authority and the content before publication. You are confirming the property is available as stated.'
              : 'A verified, unexpired owner authority for this property is required. Submit the authority document from the property page first.'
          }
          path={`/api/v1/listings/${listing.id}/submit`}
          body={{ expectedVersion: listing.version }}
          confirmLabel="Submit"
          variant="primary"
          successTitle="Submitted for moderation"
          disabled={!authorityOk}
          disabledReason="Owner authority is not verified"
        />
      ) : null}
      {live ? (
        <ConfirmedAction
          label="Confirm still available"
          title="Confirm availability?"
          description="Restarts the 90-day availability window. The listing leaves the public site when the window lapses without a confirmation."
          path={`/api/v1/listings/${listing.id}/confirm-availability`}
          body={{ expectedVersion: listing.version }}
          confirmLabel="Confirm availability"
          successTitle="Availability confirmed"
        />
      ) : null}
      {withdrawable ? (
        <ConfirmedAction
          label={status === 'draft' || status === 'rejected' ? 'Archive draft' : 'Withdraw'}
          title={
            status === 'draft' || status === 'rejected'
              ? 'Archive this draft?'
              : 'Withdraw this listing?'
          }
          description="A withdrawn listing leaves the public site immediately and cannot be resubmitted; create a new listing to relist. The reason is recorded."
          path={`/api/v1/listings/${listing.id}/withdraw`}
          body={{ expectedVersion: listing.version }}
          reasonKey="reason"
          confirmLabel={status === 'draft' || status === 'rejected' ? 'Archive' : 'Withdraw'}
          variant="ghost"
          tone="danger"
          successTitle={
            status === 'draft' || status === 'rejected' ? 'Draft archived' : 'Listing withdrawn'
          }
        />
      ) : null}
      {!authorityOk && !live ? (
        <Alert tone="info" title="Owner authority" className="basis-full">
          {listing.ownerAuthority
            ? `The newest authority for this property is ${listing.ownerAuthority.effectiveStatus}.`
            : 'No owner authority has been submitted for this property.'}{' '}
          Moderation needs a verified, unexpired one.
        </Alert>
      ) : null}
    </div>
  );
}

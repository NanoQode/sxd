import Link from 'next/link';
import { Alert } from '@simplexd/ui';

/**
 * Explains why a server read was refused instead of failing the whole page:
 * a missing authenticator links to enrolment, a disabled feature says so, and
 * anything else shows the server's message.
 */
export function LoadError({
  code,
  message,
  what,
}: {
  code: string;
  message: string;
  what: string;
}) {
  if (code === 'mfa_required') {
    return (
      <Alert tone="warning" title={`${what} needs a verified authenticator`}>
        Your role allows this, but the server requires multi-factor authentication for it.{' '}
        <Link href="/admin/security/mfa" className="font-medium underline">
          Enrol or verify your authenticator
        </Link>{' '}
        and reload.
      </Alert>
    );
  }
  if (code === 'feature_disabled') {
    return (
      <Alert tone="info" title={`${what} is switched off`}>
        The feature flag for this module is disabled, so its endpoints answer as if it did not
        exist. Records created while it was on are retained.{' '}
        <Link href="/admin/settings/feature-flags" className="font-medium underline">
          Feature flags
        </Link>
        .
      </Alert>
    );
  }
  if (code === 'forbidden') {
    return (
      <Alert tone="warning" title={`You cannot open ${what.toLowerCase()}`}>
        {message}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={`${what} could not be loaded`}>
      {message} ({code})
    </Alert>
  );
}

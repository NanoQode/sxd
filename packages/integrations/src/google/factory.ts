import { DevCalendarProvider, isDevelopmentEnvironment, type DevCalendarOptions } from './dev';
import { CalendarNotConfiguredError } from './errors';
import { GoogleCalendarProvider, type GoogleCalendarProviderOptions } from './google';
import type { CalendarProvider, CalendarProviderId } from './types';

export interface CalendarProviderFactoryInput {
  appEnv: string;
  /** Defaults to `google` when a client id and secret are present, otherwise `dev`. */
  adapter?: CalendarProviderId;
  clientId?: string | null;
  clientSecret?: string | null;
  /** `${APP_URL}/api/v1/admin/integrations/google/callback` */
  redirectUri: string;
  google?: Pick<
    GoogleCalendarProviderOptions,
    'calendarClientFactory' | 'oauthClientFactory' | 'requestTimeoutMs' | 'now'
  >;
  dev?: Omit<DevCalendarOptions, 'appEnv'>;
}

/** Path the admin console shows next to the client-ID field; must match the Cloud Console entry exactly. */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/v1/admin/integrations/google/callback';

export function googleRedirectUri(
  appUrl: string,
  path: string = GOOGLE_OAUTH_CALLBACK_PATH,
): string {
  return `${appUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Builds the calendar provider for the active configuration. A client ID and
 * secret alone do not make a connected calendar: the caller still needs a
 * stored organiser grant (calendar_connections) before booking.
 */
export function createCalendarProvider(input: CalendarProviderFactoryInput): CalendarProvider {
  const hasCredentials = Boolean(input.clientId && input.clientSecret);
  const adapter = input.adapter ?? (hasCredentials ? 'google' : 'dev');
  if (adapter === 'dev') {
    if (!isDevelopmentEnvironment(input.appEnv)) {
      throw new CalendarNotConfiguredError(
        `Google Workspace is not configured and the development calendar adapter is refused when APP_ENV=${input.appEnv}`,
      );
    }
    return new DevCalendarProvider({ appEnv: input.appEnv, ...(input.dev ?? {}) });
  }
  if (!hasCredentials) {
    throw new CalendarNotConfiguredError(
      'Google Workspace is not configured: add the OAuth client ID and secret in Admin → Integrations',
    );
  }
  return new GoogleCalendarProvider({
    clientId: input.clientId as string,
    clientSecret: input.clientSecret as string,
    redirectUri: input.redirectUri,
    ...(input.google ?? {}),
  });
}

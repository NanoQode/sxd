'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  // The sign-in form handles the two-factor redirect with the router.
  plugins: [organizationClient(), twoFactorClient(), adminClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

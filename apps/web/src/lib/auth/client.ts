'use client';

import { createAuthClient } from 'better-auth/react';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  // The sign-in form handles the two-factor redirect with the router.
  plugins: [organizationClient(), twoFactorClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

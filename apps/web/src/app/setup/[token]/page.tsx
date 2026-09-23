import { createHash } from 'node:crypto';
import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { getDb, schema, systemContext, withActor } from '@simplexd/db';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ThemeToggle,
} from '@simplexd/ui';
import { getSession } from '@/lib/auth/session';
import { SetupAdminForm } from './setup-form';

export const metadata: Metadata = {
  title: 'Administrator setup',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

type SetupTokenRow = typeof schema.setupTokens.$inferSelect;

/** Loads the token outside the component body so the purity rule is satisfied. */
async function loadSetupToken(
  token: string,
): Promise<{ row: SetupTokenRow | undefined; valid: boolean }> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const record = await withActor(getDb(), systemContext(), (tx) =>
    tx.select().from(schema.setupTokens).where(eq(schema.setupTokens.tokenHash, tokenHash)),
  );
  const row = record[0];
  const now = new Date();
  const valid = Boolean(
    row && !row.usedAt && row.expiresAt.getTime() > now.getTime() && row.purpose === 'first_admin',
  );
  return { row, valid };
}

export default async function SetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { row, valid } = await loadSetupToken(token);
  const session = await getSession();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sx-container flex h-16 items-center justify-between">
        <span className="font-display text-lg font-semibold">SimplexD</span>
        <ThemeToggle compact />
      </header>
      <main className="sx-container flex flex-1 items-start justify-center py-8">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">First administrator setup</CardTitle>
            <CardDescription>
              Create the super administrator account for this installation. This link works once.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!valid || !row ? (
              <Alert tone="danger" title="This setup link is invalid, used or expired">
                Run <code>pnpm db:bootstrap-admin --email you@example.com</code> on the server to
                issue a new one.
              </Alert>
            ) : (
              <SetupAdminForm
                token={token}
                email={row.email}
                signedInEmail={session?.user.email ?? null}
              />
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

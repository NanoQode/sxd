import Link from 'next/link';
import { Button } from '@simplexd/ui';

/** Placeholder until the Wave 1 homepage lands. */
export default function HomePage() {
  return (
    <main className="sx-container py-16">
      <h1 className="font-display text-3xl font-semibold">SimplexD</h1>
      <p className="mt-2 max-w-prose text-fg-muted">
        Property services and oversight for Nigerians at home and abroad.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/sign-in">
          <Button>Sign in</Button>
        </Link>
      </div>
    </main>
  );
}
